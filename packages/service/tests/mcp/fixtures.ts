import type {
  CleanupReceipt, PrepareOperationRecord, PrepareWorkspaceRequest, RunId,
  WorkspaceLease, WorkspaceSnapshot,
} from "../../src/index.js";

export class FixtureWorkspaceProvider {
  readonly id = "fixture";
  readonly #rootPath: string;
  readonly #operations = new Map<string, PrepareOperationRecord>();
  #snapshotSequence = 0;

  constructor(rootPath: string) { this.#rootPath = rootPath; }

  getOperation(operationId: string) { return this.#operations.get(operationId); }

  async prepare(request: PrepareWorkspaceRequest, signal: AbortSignal): Promise<WorkspaceSnapshot> {
    const startedAt = new Date().toISOString();
    this.#operations.set(request.operationId, { operationId: request.operationId,
      status: "preparing", requestedRevision: request.revision, startedAt });
    await new Promise(resolve => setTimeout(resolve, 5));
    if (signal.aborted) throw new Error("Preparation aborted.");
    const snapshotId = `snapshot:fixture-${++this.#snapshotSequence}`;
    const snapshot = Object.freeze({ operationId: request.operationId, snapshotId,
      resolvedRevision: request.revision, rootPath: this.#rootPath,
      runtimeMetadata: { provider: this.id }, autMetadata: { fixture: "true" } });
    this.#operations.set(request.operationId, { operationId: request.operationId,
      status: "ready", requestedRevision: request.revision, startedAt,
      finishedAt: new Date().toISOString(), snapshotId, resolvedRevision: request.revision });
    return snapshot;
  }

  acquireLease(snapshot: WorkspaceSnapshot, runId: RunId): WorkspaceLease {
    return { snapshotId: snapshot.snapshotId, runId, generation: 1,
      acquiredAt: new Date().toISOString() };
  }

  completeLease(_lease: WorkspaceLease, _cleanup: CleanupReceipt): void {}

  async release(snapshot: WorkspaceSnapshot, _signal: AbortSignal): Promise<CleanupReceipt> {
    return { snapshotId: snapshot.snapshotId, status: "confirmed", tainted: false,
      attemptedAt: new Date().toISOString() };
  }
}
