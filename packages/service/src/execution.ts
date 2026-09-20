import type { RunId, TaskId, TestId } from "./ids.js";
import type { TestDefinition } from "./test-definition.js";
import type { CleanupReceipt, WorkspaceSnapshot } from "./workspace.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type NormalizedParameters = Readonly<Record<string, JsonValue>>;
export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type BusinessOutcome =
  | "passed"
  | "failed"
  | "skipped"
  | "unsupported"
  | "unknown";

export interface CaseSpecExecutionLink {
  readonly namespace: "case-spec";
  readonly caseSpecId: string;
}

export interface AgentExecutionLink {
  readonly namespace: "agent";
  readonly agentRunId: string;
  readonly agentCallIds: readonly string[];
}

export interface NativeExecutionLink {
  readonly namespace: "native";
  readonly nativeOperationId: string;
}

export interface ExecutionLinks {
  readonly caseSpecs: readonly CaseSpecExecutionLink[];
  readonly agentRuns: readonly AgentExecutionLink[];
  readonly nativeOperations: readonly NativeExecutionLink[];
}

export interface RunCorrelation {
  readonly runId: RunId;
  readonly snapshot: Pick<WorkspaceSnapshot, "snapshotId" | "resolvedRevision">;
  readonly testId: TestId;
  readonly parameters: NormalizedParameters;
  readonly taskId?: TaskId;
  /** Optional cross-system identities retain their own explicit namespaces. */
  readonly executionLinks?: ExecutionLinks;
}

export interface Artifact {
  readonly artifactId: string;
  readonly runId: RunId;
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface RunResultBase extends RunCorrelation {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly artifacts: readonly Artifact[];
  readonly cleanup: CleanupReceipt;
}

interface CompletedRunResultBase extends RunResultBase {
  readonly executionStatus: "completed";
}

export interface PassedRunResult extends CompletedRunResultBase {
  /** Execution completed and every required business criterion passed. */
  readonly outcome: "passed";
  readonly reason?: never;
}

export interface BusinessFailedRunResult extends CompletedRunResultBase {
  /** Execution completed and at least one known business criterion failed. */
  readonly outcome: "failed";
  readonly reason: string;
}

export interface UnknownRunResult extends CompletedRunResultBase {
  /** Execution completed, but business evidence was insufficient for a verdict. */
  readonly outcome: "unknown";
  readonly reason: string;
}

export interface SkippedRunResult extends CompletedRunResultBase {
  readonly outcome: "skipped";
  readonly reason: string;
}

export interface UnsupportedRunResult extends CompletedRunResultBase {
  readonly outcome: "unsupported";
  readonly reason: string;
}

/** Successful execution completion is distinct from the business verdict. */
export type CompletedRunResult =
  | PassedRunResult
  | BusinessFailedRunResult
  | UnknownRunResult
  | SkippedRunResult
  | UnsupportedRunResult;

export interface IncompleteRunResult extends RunResultBase {
  readonly executionStatus: "failed" | "cancelled" | "interrupted";
  /** Infrastructure/lifecycle failure must not be presented as a product verdict. */
  readonly outcome: null;
  readonly error: ExecutionError;
}

export type RunResult = CompletedRunResult | IncompleteRunResult;

export interface ExecutionError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ExecuteRequest extends RunCorrelation {
  readonly definition: TestDefinition;
  readonly workspace: WorkspaceSnapshot;
}

export interface CancelRequest {
  readonly runId: RunId;
  readonly reason: string;
}

export interface CancelResult {
  readonly runId: RunId;
  readonly disposition: "accepted" | "already-terminal" | "not-found";
}

export interface CleanupRequest {
  readonly runId: RunId;
  readonly snapshot: WorkspaceSnapshot;
}

export interface Executor {
  readonly id: string;
  execute(request: ExecuteRequest, signal: AbortSignal): Promise<RunResult>;
  cancel(request: CancelRequest, signal: AbortSignal): Promise<CancelResult>;
  cleanup(request: CleanupRequest, signal: AbortSignal): Promise<CleanupReceipt>;
}
