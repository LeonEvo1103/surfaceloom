import type {
  Artifact, BusinessOutcome, ExecutionError, ExecutionLinks, NormalizedParameters,
  RunResult, RunStatus,
} from "../execution.js";
import type { RunId, TaskId, TestId } from "../ids.js";
import type { CleanupReceipt } from "../workspace.js";

export interface RunReservation {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly proposedRunId: RunId;
  readonly snapshot: Readonly<{ snapshotId: string; resolvedRevision: string }>;
  readonly testId: TestId;
  readonly parameters: NormalizedParameters;
  readonly taskId?: TaskId;
  readonly executionLinks?: ExecutionLinks;
  readonly createdAt: string;
}

export interface StoredRunRecord {
  readonly schemaVersion: "surfaceloom.service-run/v1";
  readonly revision: number;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly runId: RunId;
  readonly snapshot: Readonly<{ snapshotId: string; resolvedRevision: string }>;
  readonly testId: TestId;
  readonly parameters: NormalizedParameters;
  readonly taskId?: TaskId;
  readonly executionLinks?: ExecutionLinks;
  readonly status: RunStatus;
  readonly outcome: BusinessOutcome | null;
  readonly artifacts: readonly Artifact[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly result?: RunResult;
  readonly error?: ExecutionError;
  readonly cleanup?: CleanupReceipt;
  readonly workspaceRelease?: CleanupReceipt;
  readonly tainted: boolean;
}

export interface ReserveRunResult {
  readonly created: boolean;
  readonly record: StoredRunRecord;
}

export interface RunStore {
  reserve(input: RunReservation): Promise<ReserveRunResult>;
  get(runId: RunId): Promise<StoredRunRecord | undefined>;
  getByRequestId(requestId: string): Promise<StoredRunRecord | undefined>;
  list(): Promise<readonly StoredRunRecord[]>;
  markRunning(runId: RunId, startedAt: string): Promise<StoredRunRecord>;
  markCancelling(runId: RunId, updatedAt: string): Promise<StoredRunRecord>;
  finish(runId: RunId, result: RunResult, workspaceRelease?: CleanupReceipt): Promise<StoredRunRecord>;
  interrupt(runId: RunId, error: ExecutionError, cleanup: CleanupReceipt,
    finishedAt: string): Promise<StoredRunRecord>;
  attachArtifact(runId: RunId, artifact: Artifact, updatedAt: string): Promise<StoredRunRecord>;
  recoverInterrupted(now: string): Promise<readonly StoredRunRecord[]>;
  close(): Promise<void>;
}

export interface PutArtifactRequest {
  readonly runId: RunId;
  readonly name: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
}

export interface StoredArtifact {
  readonly artifact: Artifact;
  readonly data: Uint8Array;
}

export interface ArtifactStore {
  put(request: PutArtifactRequest): Promise<Artifact>;
  get(artifactId: string): Promise<StoredArtifact | undefined>;
  list(runId: RunId): Promise<readonly Artifact[]>;
}

export class StoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export class StoreCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreCorruptionError";
  }
}
