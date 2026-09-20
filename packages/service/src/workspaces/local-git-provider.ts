import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseOperationId, type RunId } from "../ids.js";
import { cloneSafeData, deepFreeze } from "../safe-data.js";
import type {
  CleanupReceipt,
  PrepareWorkspaceRequest,
  WorkspaceProvider,
  WorkspaceSnapshot,
} from "../workspace.js";
import { runWorkspaceCommand } from "./command.js";
import type {
  PrepareOperationRecord,
  WorkspaceCommandRunner,
  WorkspaceLease,
} from "./contracts.js";
import { WorkspacePreparationError } from "./contracts.js";
import { createDetachedSnapshot, resolveCleanRevision } from "./local-git-repository.js";
import {
  freezeSnapshot,
  normalizeError,
  pathsOverlap,
  readRequest,
  type LocalGitWorkspaceProviderOptions,
  workspaceTimestamp,
} from "./local-git-support.js";
import {
  createSnapshotDirectory,
  discardPreparationTree,
  ensureSnapshotRoot,
  parseRelativeLocator,
  resolveSourcePath,
  type DirectoryIdentity,
  verifySnapshotDirectoryIdentity,
  verifyWorkspacePathIdentities,
} from "./path-safety.js";
import { SnapshotLifecycleRegistry } from "./snapshot-lifecycle.js";
export type { LocalGitWorkspaceProviderOptions } from "./local-git-support.js";
/** Local Git snapshots are detached, read-only copies and are never reused. */
export class LocalGitWorkspaceProvider implements WorkspaceProvider {
  readonly id = "local-git";
  readonly #sourceRoot: string;
  readonly #snapshotRoot: string;
  readonly #gitBinary: string;
  readonly #runner: WorkspaceCommandRunner;
  readonly #now: () => Date;
  readonly #createUuid: () => string;
  readonly #operations = new Map<string, PrepareOperationRecord>();
  readonly #reservedSnapshotIds = new Set<string>();
  readonly #lifecycle: SnapshotLifecycleRegistry;

  constructor(options: LocalGitWorkspaceProviderOptions) {
    this.#sourceRoot = path.resolve(options.sourceRoot);
    this.#snapshotRoot = path.resolve(options.snapshotRoot);
    if (pathsOverlap(this.#sourceRoot, this.#snapshotRoot)) {
      throw new WorkspacePreparationError(
        "invalid-request",
        "Workspace source and snapshot roots must not overlap.",
      );
    }
    this.#gitBinary = options.gitBinary ?? "git";
    this.#runner = options.commandRunner ?? runWorkspaceCommand;
    this.#now = options.now ?? (() => new Date());
    this.#createUuid = options.createUuid ?? randomUUID;
    this.#lifecycle = new SnapshotLifecycleRegistry(this.#now);
  }

  getOperation(operationId: string): Readonly<PrepareOperationRecord> | undefined {
    const record = this.#operations.get(parseOperationId(operationId));
    return record === undefined ? undefined : deepFreeze(cloneSafeData(record));
  }

  async prepare(
    request: PrepareWorkspaceRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceSnapshot> {
    const safeRequest = readRequest(request);
    if (this.#operations.has(safeRequest.operationId)) {
      throw new WorkspacePreparationError(
        "operation-conflict",
        "Workspace operationId has already been used.",
      );
    }
    const startedAt = workspaceTimestamp(this.#now);
    this.#operations.set(safeRequest.operationId, {
      operationId: safeRequest.operationId,
      status: "preparing",
      requestedRevision: safeRequest.revision,
      startedAt,
    });

    let destination: string | undefined;
    let destinationIdentity: DirectoryIdentity | undefined;
    let snapshotRootIdentity: DirectoryIdentity | undefined;
    try {
      if (safeRequest.source.provider !== this.id) {
        throw new WorkspacePreparationError(
          "invalid-request",
          `Workspace source provider must be ${this.id}.`,
        );
      }
      const uuid = this.#createUuid();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(uuid)) {
        throw new WorkspacePreparationError("prepare-failed", "Workspace snapshot identity is invalid.");
      }
      const snapshotId = `snapshot:${uuid}`;
      if (this.#reservedSnapshotIds.has(snapshotId)) {
        throw new WorkspacePreparationError(
          "snapshot-unsafe",
          "Workspace snapshot identity has already been reserved.",
        );
      }
      this.#reservedSnapshotIds.add(snapshotId);
      destination = path.join(this.#snapshotRoot, `snapshot-${uuid}`);

      const segments = parseRelativeLocator(safeRequest.source.locator);
      const [sourceIdentity, resolvedSnapshotRootIdentity] = await Promise.all([
        resolveSourcePath(this.#sourceRoot, segments),
        ensureSnapshotRoot(this.#snapshotRoot),
      ]);
      snapshotRootIdentity = resolvedSnapshotRootIdentity;
      const sourcePath = sourceIdentity.source.canonicalPath;
      const snapshotRoot = resolvedSnapshotRootIdentity.canonicalPath;
      if (pathsOverlap(sourceIdentity.root.canonicalPath, snapshotRoot)) {
        throw new WorkspacePreparationError(
          "path-unsafe",
          "Canonical workspace source and snapshot roots must not overlap.",
        );
      }
      const context = {
        runner: this.#runner,
        gitBinary: this.#gitBinary,
        signal,
        verifyBoundary: async () => verifyWorkspacePathIdentities(
          sourceIdentity,
          resolvedSnapshotRootIdentity,
        ),
      };
      const resolvedRevision = await resolveCleanRevision(
        sourcePath,
        safeRequest.revision,
        context,
      );
      destinationIdentity = await createSnapshotDirectory(destination, resolvedSnapshotRootIdentity);
      destination = destinationIdentity.canonicalPath;
      await createDetachedSnapshot(
        sourcePath,
        destinationIdentity,
        resolvedRevision,
        resolvedSnapshotRootIdentity,
        context,
      );
      await context.verifyBoundary();
      await verifySnapshotDirectoryIdentity(destinationIdentity, resolvedSnapshotRootIdentity);
      if (signal.aborted) throw new WorkspacePreparationError("aborted", "Workspace preparation was aborted.");
      const snapshot = freezeSnapshot({
        operationId: safeRequest.operationId,
        snapshotId,
        resolvedRevision,
        rootPath: destination,
        runtimeMetadata: {
          provider: this.id,
          platform: process.platform,
          architecture: process.arch,
          nodeVersion: process.version,
          isolation: "detached-readonly-copy",
        },
        autMetadata: {
          sourceProvider: safeRequest.source.provider,
          sourceLocator: safeRequest.source.locator,
        },
      });
      this.#lifecycle.add(snapshot, destinationIdentity, resolvedSnapshotRootIdentity);
      this.#operations.set(safeRequest.operationId, {
        operationId: safeRequest.operationId,
        status: "ready",
        requestedRevision: safeRequest.revision,
        startedAt,
        finishedAt: workspaceTimestamp(this.#now),
        snapshotId,
        resolvedRevision,
      });
      return snapshot;
    } catch (cause) {
      if (destinationIdentity !== undefined && snapshotRootIdentity !== undefined) {
        try {
          await discardPreparationTree(destinationIdentity, snapshotRootIdentity);
        } catch {
          // No path is returned; an unconfirmed partial snapshot remains unusable.
        }
      }
      const error = normalizeError(cause, signal);
      this.#operations.set(safeRequest.operationId, {
        operationId: safeRequest.operationId,
        status: "failed",
        requestedRevision: safeRequest.revision,
        startedAt,
        finishedAt: workspaceTimestamp(this.#now),
        error: { code: error.code, message: error.message },
      });
      throw error;
    }
  }

  acquireLease(snapshot: WorkspaceSnapshot, runId: RunId): WorkspaceLease {
    return this.#lifecycle.acquire(snapshot, runId);
  }

  completeLease(lease: WorkspaceLease, cleanup: CleanupReceipt): void {
    this.#lifecycle.complete(lease, cleanup);
  }

  async release(snapshot: WorkspaceSnapshot, signal: AbortSignal): Promise<CleanupReceipt> {
    return this.#lifecycle.release(snapshot, signal);
  }
}
