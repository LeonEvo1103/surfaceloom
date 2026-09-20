import { parseRunId, type RunId } from "../ids.js";
import type { CleanupReceipt, WorkspaceSnapshot } from "../workspace.js";
import type { WorkspaceLease } from "./contracts.js";
import { WorkspacePreparationError } from "./contracts.js";
import {
  cleanupReceipt,
  readCleanup,
  type SnapshotState,
  workspaceTimestamp,
} from "./local-git-support.js";
import { removeSnapshotTree } from "./path-safety.js";
import type { DirectoryIdentity } from "./path-safety.js";

export class SnapshotLifecycleRegistry {
  readonly #now: () => Date;
  readonly #snapshots = new Map<string, SnapshotState>();
  readonly #released = new Map<string, CleanupReceipt>();
  #nextLeaseGeneration = 0;
  #nextReleaseToken = 0;

  constructor(now: () => Date) {
    this.#now = now;
  }

  add(
    snapshot: WorkspaceSnapshot,
    directoryIdentity: DirectoryIdentity,
    snapshotRootIdentity: DirectoryIdentity,
  ): void {
    if (this.#snapshots.has(snapshot.snapshotId) || this.#released.has(snapshot.snapshotId)) {
      throw new WorkspacePreparationError("snapshot-unsafe", "Workspace snapshot identity is not unique.");
    }
    this.#snapshots.set(snapshot.snapshotId, {
      snapshot,
      directoryIdentity,
      snapshotRootIdentity,
      quarantined: false,
    });
  }

  acquire(snapshot: WorkspaceSnapshot, runId: RunId): WorkspaceLease {
    const state = this.#require(snapshot);
    const parsedRunId = parseRunId(runId);
    if (state.quarantined || state.activeLease !== undefined || state.releaseToken !== undefined) {
      throw new WorkspacePreparationError(
        "snapshot-unsafe",
        "Workspace snapshot is active, releasing, or quarantined and cannot be leased.",
      );
    }
    const lease = Object.freeze({
      snapshotId: snapshot.snapshotId,
      runId: parsedRunId,
      generation: ++this.#nextLeaseGeneration,
      acquiredAt: workspaceTimestamp(this.#now),
    });
    state.activeLease = lease;
    return lease;
  }

  complete(lease: WorkspaceLease, cleanup: CleanupReceipt): void {
    const state = this.#snapshots.get(lease.snapshotId);
    if (state?.activeLease === undefined
      || state.activeLease.runId !== lease.runId
      || state.activeLease.generation !== lease.generation
      || state.activeLease.acquiredAt !== lease.acquiredAt) {
      throw new WorkspacePreparationError("snapshot-unsafe", "Workspace lease is not active.");
    }
    const evidence = readCleanup(cleanup, lease);
    delete state.activeLease;
    state.lastRunId = lease.runId;
    state.quarantined = evidence.status === "unconfirmed" || evidence.tainted;
  }

  async release(snapshot: WorkspaceSnapshot, signal: AbortSignal): Promise<CleanupReceipt> {
    const released = this.#released.get(snapshot.snapshotId);
    if (released !== undefined) return released;
    const state = this.#require(snapshot);
    if (state.activeLease !== undefined || state.quarantined || signal.aborted) {
      return this.#unconfirmed(state, signal.aborted
        ? "Snapshot release was aborted."
        : state.activeLease !== undefined
          ? "Snapshot still has an active run lease."
          : "Snapshot is quarantined by unconfirmed cleanup evidence.");
    }
    if (state.releasePromise !== undefined) return state.releasePromise;
    const releaseToken = ++this.#nextReleaseToken;
    state.releaseToken = releaseToken;
    state.releasePromise = this.#releaseReady(state, signal, releaseToken);
    return state.releasePromise;
  }

  async #releaseReady(
    state: SnapshotState,
    signal: AbortSignal,
    releaseToken: number,
  ): Promise<CleanupReceipt> {
    try {
      if (signal.aborted || state.releaseToken !== releaseToken
        || state.activeLease !== undefined || state.quarantined) {
        state.quarantined = true;
        return this.#unconfirmed(state, "Snapshot release safety changed before removal.");
      }
      await removeSnapshotTree(state.directoryIdentity, state.snapshotRootIdentity);
      const receipt = cleanupReceipt(
        state,
        workspaceTimestamp(this.#now),
        "confirmed",
        false,
      );
      this.#snapshots.delete(state.snapshot.snapshotId);
      this.#released.set(state.snapshot.snapshotId, receipt);
      return receipt;
    } catch {
      state.quarantined = true;
      return this.#unconfirmed(state, "Snapshot removal could not be confirmed.");
    }
  }

  #require(snapshot: WorkspaceSnapshot): SnapshotState {
    const state = this.#snapshots.get(snapshot.snapshotId);
    if (state === undefined
      || state.snapshot.operationId !== snapshot.operationId
      || state.snapshot.rootPath !== snapshot.rootPath
      || state.snapshot.resolvedRevision !== snapshot.resolvedRevision) {
      throw new WorkspacePreparationError("snapshot-unsafe", "Workspace snapshot is unknown or mismatched.");
    }
    return state;
  }

  #unconfirmed(state: SnapshotState, detail: string): CleanupReceipt {
    return cleanupReceipt(state, workspaceTimestamp(this.#now), "unconfirmed", true, detail);
  }
}
