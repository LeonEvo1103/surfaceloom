import { realpath } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceCommandRunner } from "./contracts.js";
import { WorkspacePreparationError } from "./contracts.js";
import { runGit } from "./command.js";
import {
  makeTreeReadOnly,
  rejectTreeSymlinks,
  verifySnapshotDirectoryIdentity,
  type DirectoryIdentity,
} from "./path-safety.js";

interface GitContext {
  readonly runner: WorkspaceCommandRunner;
  readonly gitBinary: string;
  readonly signal: AbortSignal;
  readonly verifyBoundary: () => Promise<void>;
}

export async function resolveCleanRevision(
  sourcePath: string,
  revision: string,
  context: GitContext,
): Promise<string> {
  await context.verifyBoundary();
  await requireRepositoryRoot(sourcePath, context);
  await requireClean(sourcePath, context);
  const result = await git(sourcePath, [
    "rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`,
  ], context);
  if (result.exitCode !== 0) {
    throw new WorkspacePreparationError(
      "revision-unresolved",
      "Requested workspace revision could not be resolved to a commit.",
    );
  }
  const resolved = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(resolved)) {
    throw new WorkspacePreparationError(
      "revision-unresolved",
      "Git returned an invalid resolved revision.",
    );
  }
  await context.verifyBoundary();
  return resolved;
}

export async function createDetachedSnapshot(
  sourcePath: string,
  destination: DirectoryIdentity,
  resolvedRevision: string,
  snapshotRoot: DirectoryIdentity,
  context: GitContext,
): Promise<void> {
  await context.verifyBoundary();
  await verifySnapshotDirectoryIdentity(destination, snapshotRoot);
  const clone = await git(snapshotRoot.canonicalPath, [
    "clone", "--no-checkout", "--local", "--no-hardlinks", "--",
    sourcePath, destination.canonicalPath,
  ], context);
  if (clone.exitCode !== 0) throw prepareFailure("Git clone failed.");
  await context.verifyBoundary();
  await verifySnapshotDirectoryIdentity(destination, snapshotRoot);

  const checkout = await snapshotGit(destination, snapshotRoot, [
    "checkout", "--detach", "--force", resolvedRevision,
  ], context);
  if (checkout.exitCode !== 0) throw prepareFailure("Git detached checkout failed.");
  await verifySnapshotDirectoryIdentity(destination, snapshotRoot);

  const head = await snapshotGit(
    destination,
    snapshotRoot,
    ["rev-parse", "--verify", "HEAD"],
    context,
  );
  if (head.exitCode !== 0 || head.stdout.trim() !== resolvedRevision) {
    throw prepareFailure("Workspace snapshot HEAD did not match the resolved revision.");
  }
  await requireCleanSnapshot(destination, snapshotRoot, context);
  await requireClean(sourcePath, context);
  await verifySnapshotDirectoryIdentity(destination, snapshotRoot);
  await rejectTreeSymlinks(destination.canonicalPath);
  await verifySnapshotDirectoryIdentity(destination, snapshotRoot);
  await makeTreeReadOnly(destination, snapshotRoot);
  await requireCleanSnapshot(destination, snapshotRoot, context);
  await context.verifyBoundary();
  await verifySnapshotDirectoryIdentity(destination, snapshotRoot);
}

async function requireRepositoryRoot(sourcePath: string, context: GitContext): Promise<void> {
  const result = await git(sourcePath, ["rev-parse", "--show-toplevel"], context);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw prepareFailure("Workspace source is not a Git repository root.");
  }
  const [reported, expected] = await Promise.all([
    realpath(path.resolve(result.stdout.trim())),
    realpath(sourcePath),
  ]);
  if (reported !== expected) {
    throw prepareFailure("Workspace source must name the Git repository root.");
  }
}

async function requireClean(sourcePath: string, context: GitContext): Promise<void> {
  const result = await git(sourcePath, [
    "status", "--porcelain=v1", "--untracked-files=all",
  ], context);
  if (result.exitCode !== 0) throw prepareFailure("Git worktree status could not be verified.");
  if (result.stdout.length !== 0) {
    throw new WorkspacePreparationError(
      "dirty-worktree",
      "Workspace source or snapshot is dirty; preparation does not fall back to it.",
    );
  }
}

async function requireCleanSnapshot(
  destination: DirectoryIdentity,
  snapshotRoot: DirectoryIdentity,
  context: GitContext,
): Promise<void> {
  const result = await snapshotGit(destination, snapshotRoot, [
    "status", "--porcelain=v1", "--untracked-files=all",
  ], context);
  if (result.exitCode !== 0) throw prepareFailure("Git worktree status could not be verified.");
  if (result.stdout.length !== 0) {
    throw new WorkspacePreparationError(
      "dirty-worktree",
      "Workspace source or snapshot is dirty; preparation does not fall back to it.",
    );
  }
}

async function snapshotGit(
  destination: DirectoryIdentity,
  snapshotRoot: DirectoryIdentity,
  args: readonly string[],
  context: GitContext,
) {
  await verifySnapshotDirectoryIdentity(destination, snapshotRoot);
  return git(destination.canonicalPath, args, context);
}

async function git(
  cwd: string,
  args: readonly string[],
  context: GitContext,
) {
  if (context.signal.aborted) {
    throw new WorkspacePreparationError("aborted", "Workspace preparation was aborted.");
  }
  try {
    await context.verifyBoundary();
    return await runGit(context.runner, context.gitBinary, cwd, args, context.signal);
  } catch (error) {
    if (context.signal.aborted || (error as { name?: unknown }).name === "AbortError") {
      throw new WorkspacePreparationError(
        "aborted",
        "Workspace preparation was aborted.",
        { cause: error },
      );
    }
    throw prepareFailure("Git command failed to start or complete.", error);
  }
}

function prepareFailure(message: string, cause?: unknown): WorkspacePreparationError {
  return new WorkspacePreparationError("prepare-failed", message, { cause });
}
