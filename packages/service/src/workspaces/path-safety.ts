import { chmod, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { WorkspacePreparationError } from "./contracts.js";

export interface DirectoryIdentity {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

export interface SourcePathIdentity {
  readonly root: DirectoryIdentity;
  readonly source: DirectoryIdentity;
}

export function parseRelativeLocator(locator: unknown): readonly string[] {
  if (typeof locator !== "string" || locator.length === 0 || locator.length > 500) {
    throw unsafe("Workspace source locator must be a bounded relative path.");
  }
  if (path.isAbsolute(locator) || /^[A-Za-z]:[\\/]/u.test(locator)) {
    throw unsafe("Workspace source locator must not be absolute.");
  }
  const segments = locator.split(/[\\/]/u);
  if (segments.some((segment) =>
    segment.length === 0 || segment === "." || segment === ".."
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment))) {
    throw unsafe("Workspace source locator contains an unsafe path segment.");
  }
  return segments;
}

export async function resolveSourcePath(
  sourceRoot: string,
  segments: readonly string[],
): Promise<SourcePathIdentity> {
  await requireDirectoryWithoutSymlink(sourceRoot, "Workspace source root");
  let current = sourceRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    await requireDirectoryWithoutSymlink(current, "Workspace source path");
  }
  const [canonicalRoot, canonicalSource] = await Promise.all([
    realpath(sourceRoot),
    realpath(current),
  ]);
  if (!isWithin(canonicalRoot, canonicalSource)) {
    throw unsafe("Workspace source escapes the configured source root.");
  }
  return {
    root: await captureDirectoryIdentity(canonicalRoot, "Workspace source root"),
    source: await captureDirectoryIdentity(canonicalSource, "Workspace source path"),
  };
}

export async function ensureSnapshotRoot(snapshotRoot: string): Promise<DirectoryIdentity> {
  await mkdir(snapshotRoot, { recursive: true });
  await requireDirectoryWithoutSymlink(snapshotRoot, "Workspace snapshot root");
  return captureDirectoryIdentity(await realpath(snapshotRoot), "Workspace snapshot root");
}

export async function createSnapshotDirectory(
  destination: string,
  snapshotRoot: DirectoryIdentity,
): Promise<DirectoryIdentity> {
  await verifyDirectoryIdentity(snapshotRoot, "Workspace snapshot root");
  const canonicalParent = await realpath(path.dirname(destination));
  if (canonicalParent !== snapshotRoot.canonicalPath) {
    throw snapshotUnsafe("Workspace snapshot destination escapes its storage root.");
  }
  await mkdir(destination, { mode: 0o755 });
  const canonicalPath = await realpath(destination);
  const identity = await captureDirectoryIdentity(canonicalPath, "Workspace snapshot destination");
  await verifySnapshotDirectoryIdentity(identity, snapshotRoot);
  return identity;
}

export async function verifySnapshotDirectoryIdentity(
  snapshot: DirectoryIdentity,
  snapshotRoot: DirectoryIdentity,
): Promise<void> {
  try {
    await verifyDirectoryIdentity(snapshotRoot, "Workspace snapshot root");
    const canonicalSnapshot = await verifyDirectoryIdentity(snapshot, "Workspace snapshot destination");
    if (!isWithin(snapshotRoot.canonicalPath, canonicalSnapshot)) {
      throw snapshotUnsafe("Workspace snapshot destination escapes its storage root.");
    }
  } catch (error) {
    if (error instanceof WorkspacePreparationError && error.code === "snapshot-unsafe") throw error;
    throw new WorkspacePreparationError(
      "snapshot-unsafe",
      "Workspace snapshot physical identity changed.",
      { cause: error },
    );
  }
}

export async function verifyWorkspacePathIdentities(
  source: SourcePathIdentity,
  snapshotRoot: DirectoryIdentity,
): Promise<void> {
  const [currentSourceRoot, currentSource, currentSnapshotRoot] = await Promise.all([
    verifyDirectoryIdentity(source.root, "Workspace source root"),
    verifyDirectoryIdentity(source.source, "Workspace source path"),
    verifyDirectoryIdentity(snapshotRoot, "Workspace snapshot root"),
  ]);
  if (!isWithin(currentSourceRoot, currentSource)) {
    throw unsafe("Workspace source no longer belongs to its configured root.");
  }
}

export async function rejectTreeSymlinks(root: string): Promise<void> {
  await walk(root, async (target, kind) => {
    if (kind === "symlink") {
      throw new WorkspacePreparationError(
        "snapshot-unsafe",
        "Workspace snapshot contains a symbolic link and was rejected.",
      );
    }
  });
}

export async function makeTreeReadOnly(
  snapshot: DirectoryIdentity,
  snapshotRoot: DirectoryIdentity,
): Promise<void> {
  const entries = await captureOwnedTree(snapshot, snapshotRoot);
  for (const entry of entries.reverse()) {
    await verifySnapshotDirectoryIdentity(snapshot, snapshotRoot);
    await verifyTreeEntry(entry);
    await chmod(entry.path, entry.mode & ~0o222);
  }
}

export async function removeSnapshotTree(
  snapshot: DirectoryIdentity,
  snapshotRoot: DirectoryIdentity,
): Promise<void> {
  const entries = await captureOwnedTree(snapshot, snapshotRoot);
  for (const entry of entries) {
    await verifySnapshotDirectoryIdentity(snapshot, snapshotRoot);
    await verifyTreeEntry(entry);
    await chmod(entry.path, entry.kind === "directory" ? 0o700 : 0o600);
  }
  await captureOwnedTree(snapshot, snapshotRoot);
  await rm(snapshot.canonicalPath, { recursive: true, force: false });
}

export async function discardPreparationTree(
  snapshot: DirectoryIdentity,
  snapshotRoot: DirectoryIdentity,
): Promise<void> {
  const entries = await captureOwnedTree(snapshot, snapshotRoot);
  for (const entry of entries) {
    await verifySnapshotDirectoryIdentity(snapshot, snapshotRoot);
    await verifyTreeEntry(entry);
    await chmod(entry.path, entry.kind === "directory" ? 0o700 : 0o600);
  }
  await captureOwnedTree(snapshot, snapshotRoot);
  await rm(snapshot.canonicalPath, { recursive: true, force: true });
}

interface TreeEntryIdentity {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly device: bigint;
  readonly inode: bigint;
}

async function captureOwnedTree(
  snapshot: DirectoryIdentity,
  snapshotRoot: DirectoryIdentity,
): Promise<TreeEntryIdentity[]> {
  await verifySnapshotDirectoryIdentity(snapshot, snapshotRoot);
  const entries: TreeEntryIdentity[] = [];
  await walk(snapshot.canonicalPath, async (target, kind, mode, device, inode) => {
    if (kind === "symlink") {
      throw snapshotUnsafe("Workspace snapshot contains a symbolic link and was rejected.");
    }
    entries.push({ path: target, kind, mode, device, inode });
  });
  await verifySnapshotDirectoryIdentity(snapshot, snapshotRoot);
  return entries;
}

async function verifyTreeEntry(entry: TreeEntryIdentity): Promise<void> {
  let descriptor;
  try {
    descriptor = await lstat(entry.path, { bigint: true });
  } catch (error) {
    throw new WorkspacePreparationError(
      "snapshot-unsafe",
      "Workspace snapshot entry identity is unavailable.",
      { cause: error },
    );
  }
  const kind = descriptor.isSymbolicLink()
    ? "symlink"
    : descriptor.isDirectory() ? "directory" : "file";
  if (kind !== entry.kind || descriptor.dev !== entry.device || descriptor.ino !== entry.inode) {
    throw snapshotUnsafe("Workspace snapshot entry physical identity changed.");
  }
}

async function walk(
  root: string,
  visitor: (
    target: string,
    kind: "directory" | "file" | "symlink",
    mode: number,
    device: bigint,
    inode: bigint,
  ) => Promise<void>,
): Promise<void> {
  const descriptor = await lstat(root, { bigint: true });
  const kind = descriptor.isSymbolicLink()
    ? "symlink"
    : descriptor.isDirectory() ? "directory" : "file";
  await visitor(root, kind, Number(descriptor.mode & 0o7777n), descriptor.dev, descriptor.ino);
  if (kind !== "directory") return;
  const entries = await readdir(root);
  entries.sort();
  for (const entry of entries) await walk(path.join(root, entry), visitor);
}

async function requireDirectoryWithoutSymlink(target: string, label: string): Promise<void> {
  let descriptor;
  try {
    descriptor = await lstat(target);
  } catch (error) {
    throw new WorkspacePreparationError("path-unsafe", `${label} is unavailable.`, { cause: error });
  }
  if (descriptor.isSymbolicLink() || !descriptor.isDirectory()) {
    throw unsafe(`${label} must be a real directory, not a symbolic link.`);
  }
}

async function captureDirectoryIdentity(
  canonicalPath: string,
  label: string,
): Promise<DirectoryIdentity> {
  const descriptor = await lstat(canonicalPath, { bigint: true });
  if (descriptor.isSymbolicLink() || !descriptor.isDirectory()) {
    throw unsafe(`${label} must be a real directory.`);
  }
  return Object.freeze({
    canonicalPath,
    device: descriptor.dev,
    inode: descriptor.ino,
  });
}

async function verifyDirectoryIdentity(
  identity: DirectoryIdentity,
  label: string,
): Promise<string> {
  let descriptor;
  let canonicalPath;
  try {
    [descriptor, canonicalPath] = await Promise.all([
      lstat(identity.canonicalPath, { bigint: true }),
      realpath(identity.canonicalPath),
    ]);
  } catch (error) {
    throw new WorkspacePreparationError("path-unsafe", `${label} identity is unavailable.`, { cause: error });
  }
  if (descriptor.isSymbolicLink() || !descriptor.isDirectory()
    || canonicalPath !== identity.canonicalPath
    || descriptor.dev !== identity.device
    || descriptor.ino !== identity.inode) {
    throw unsafe(`${label} physical identity changed during preparation.`);
  }
  return canonicalPath;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".."
    && !path.isAbsolute(relative);
}

function unsafe(message: string): WorkspacePreparationError {
  return new WorkspacePreparationError("path-unsafe", message);
}

function snapshotUnsafe(message: string): WorkspacePreparationError {
  return new WorkspacePreparationError("snapshot-unsafe", message);
}
