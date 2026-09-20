import type { OperationId, RunId } from "./ids.js";

export interface WorkspaceSource {
  readonly provider: string;
  readonly locator: string;
}

export interface PrepareWorkspaceRequest {
  readonly operationId: OperationId;
  readonly source: WorkspaceSource;
  /** Immutable revision requested by the consumer. */
  readonly revision: string;
}

export interface WorkspaceSnapshot {
  readonly operationId: OperationId;
  readonly snapshotId: string;
  readonly resolvedRevision: string;
  readonly rootPath: string;
  readonly runtimeMetadata: Readonly<Record<string, string>>;
  readonly autMetadata: Readonly<Record<string, string>>;
}

export type CleanupStatus = "confirmed" | "unconfirmed" | "not-required";

export interface CleanupReceipt {
  readonly runId?: RunId;
  readonly snapshotId: string;
  readonly status: CleanupStatus;
  readonly tainted: boolean;
  readonly attemptedAt: string;
  readonly detail?: string;
}

export interface WorkspaceProvider {
  readonly id: string;
  prepare(
    request: PrepareWorkspaceRequest,
    signal: AbortSignal,
  ): Promise<WorkspaceSnapshot>;
  release(
    snapshot: WorkspaceSnapshot,
    signal: AbortSignal,
  ): Promise<CleanupReceipt>;
}
