import type { DeadlineTaskOptions } from "./deadline-contracts.js";

export interface WorkerTrackingOptions {
  /** A declaration, not a ledger receipt or proof that no effects occurred. */
  readonly externalEffects: "none" | "possible";
}

export interface OwnedNodeWorkerOptions extends WorkerTrackingOptions {
  /** The caller must own this actual Worker instance and its termination authority. */
  readonly ownership: "owned";
}

export type WorkerStopState = "running" | "stopRequested" | "notStarted" | "settled"
  | "cooperativeStopped" | "workerExited" | "workerTerminated" | "unconfirmed";

export type WorkerFailureCode = "invalidReceipt" | "conflictingReceipt" | "taskRejected"
  | "stopUnconfirmed" | "terminationFailed" | "terminationUnconfirmed"
  | "workerError" | "forcedTermination" | "externalEffectsUnknown";

export interface WorkerFailure {
  readonly code: WorkerFailureCode;
  readonly message: string;
}

export interface WorkerSettlementSummary {
  readonly status: "fulfilled" | "rejected" | "notStarted";
  readonly observedAtMs: number | null;
  readonly cancellationRequested: boolean;
  readonly cancellationAcknowledged: boolean;
  /** Opaque values/reasons never enter serialized diagnostics. */
  readonly errorMessage: string | null;
}

/** Stop evidence only; no state establishes criteria, cleanup, or a passing Case verdict. */
export interface WorkerStopSnapshot {
  readonly isolation: "inProcess" | "nodeWorker";
  readonly state: WorkerStopState;
  /** Sticky; later stop confirmation does not authorize reuse or undo effects. */
  readonly tainted: boolean;
  readonly cancellationRequested: boolean;
  readonly externalEffects: "notApplicable" | "unverified" | "unknown";
  readonly settlement: WorkerSettlementSummary | null;
  /** Only populated by a real observed Worker exit event in the Node adapter. */
  readonly exitCode: number | null;
  readonly failures: readonly WorkerFailure[];
}

export interface WorkerTrackingHandle {
  snapshot(): WorkerStopSnapshot;
  /** Explicitly records unknown effect outcome independently of execution stop. */
  markExternalEffectsUnknown(): WorkerStopSnapshot;
}

export interface InProcessWorkerHandle extends WorkerTrackingHandle {
  readonly outcome: Promise<WorkerStopSnapshot>;
  /** May never settle; this does not invent a kill mechanism for closures/fixtures. */
  readonly settled: Promise<WorkerStopSnapshot>;
  cancel(message?: string): WorkerStopSnapshot;
}

export interface NodeWorkerHandle extends WorkerTrackingHandle {
  /** Resolves only on a real Worker exit event, including natural exit. */
  readonly exited: Promise<WorkerStopSnapshot>;
  /**
   * Requests termination once; timeout/abort bounds waiting, not termination.
   * Repeated calls share the first promise and its original waiting budget.
   */
  terminate(options: Omit<DeadlineTaskOptions, "cancellationGraceMs">): Promise<WorkerStopSnapshot>;
}
