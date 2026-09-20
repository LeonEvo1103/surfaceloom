import type { OperationId, RunId } from "../ids.js";

export type WorkspacePreparationErrorCode =
  | "aborted"
  | "dirty-worktree"
  | "invalid-request"
  | "operation-conflict"
  | "path-unsafe"
  | "prepare-failed"
  | "revision-unresolved"
  | "snapshot-unsafe";

export class WorkspacePreparationError extends Error {
  readonly code: WorkspacePreparationErrorCode;

  constructor(code: WorkspacePreparationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspacePreparationError";
    this.code = code;
  }
}

export type PrepareOperationStatus = "preparing" | "ready" | "failed";

export interface PrepareOperationRecord {
  readonly operationId: OperationId;
  readonly status: PrepareOperationStatus;
  readonly requestedRevision: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly snapshotId?: string;
  readonly resolvedRevision?: string;
  readonly error?: Readonly<{
    code: WorkspacePreparationErrorCode;
    message: string;
  }>;
}

export interface WorkspaceLease {
  readonly snapshotId: string;
  readonly runId: RunId;
  /** Monotonic provider-local identity; timestamps and runId are not lease identities. */
  readonly generation: number;
  readonly acquiredAt: string;
}

export interface WorkspaceCommandInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly shell: false;
}

export interface WorkspaceCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type WorkspaceCommandRunner = (
  invocation: WorkspaceCommandInvocation,
) => Promise<WorkspaceCommandResult>;
