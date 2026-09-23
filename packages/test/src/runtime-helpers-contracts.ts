import type { TraceValue } from "@surfaceloom/core";
import type {
  AssertionFailure, ObservationAssertionOptions, ObservationAssertionResult,
} from "./assertion-contracts.js";
import type {
  DeadlineCancellation, DeadlineClockFailure, DeadlineTaskOptions, ExecutionClock,
} from "./deadline-contracts.js";
import type { Observation, ObservationReadContext } from "./observation.js";

export type RuntimeHelperClock = ExecutionClock;

export interface BoundedObservationReadContext extends ObservationReadContext {
  /** Cooperative cancellation for the current read. */
  readonly signal: AbortSignal;
}

export type BoundedObservationReader<T extends TraceValue> = (
  context: BoundedObservationReadContext,
) => Observation<T> | Promise<Observation<T>>;

export interface BoundedObservationOptions<T extends TraceValue>
  extends Omit<ObservationAssertionOptions<T>, "clock"> {
  readonly cancellationGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly clock?: RuntimeHelperClock;
}

export type RuntimeStopStatus = "settled" | "cooperativeStopped" | "notStarted" | "unconfirmed";

export interface BoundedObservationResult<T extends TraceValue> {
  readonly status: "passed" | "failed" | "timedOut" | "cancelled" | "clockFailed";
  /** Describes the wrapper callback and its awaited read, never detached work. */
  readonly stopStatus: RuntimeStopStatus;
  readonly started: boolean;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  readonly assertion: ObservationAssertionResult<T> | null;
  readonly failure: AssertionFailure | null;
  readonly cancellation: DeadlineCancellation | null;
  readonly cancellationAcknowledged: boolean;
  readonly clockFailure: DeadlineClockFailure | null;
}

export interface BoundedDiagnosticContext {
  readonly signal: AbortSignal;
  remainingMs(): number;
}

export type BoundedDiagnosticOptions = DeadlineTaskOptions;

interface BoundedDiagnosticCommon {
  readonly stopStatus: RuntimeStopStatus;
  readonly started: boolean;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  readonly cancellation: DeadlineCancellation | null;
  readonly cancellationAcknowledged: boolean;
  readonly clockFailure: DeadlineClockFailure | null;
}

export type BoundedDiagnosticResult<T> = BoundedDiagnosticCommon & (
  | { readonly status: "captured"; readonly payload: T }
  | { readonly status: "failed"; readonly failure: AssertionFailure; readonly cause: unknown }
  | { readonly status: "timedOut" }
  | { readonly status: "cancelled" }
  | { readonly status: "clockFailed"; readonly failure: AssertionFailure }
);
