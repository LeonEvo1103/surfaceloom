import type { TraceValue } from "@surfaceloom/core";
import type { ObservationAttempt } from "./observation.js";

export interface AssertionFailure {
  readonly code: string;
  readonly message: string;
}

/** The interval uses the assertion clock's monotonic time domain. */
export type CompletenessRequirement =
  | { readonly kind: "barrier"; readonly id: string }
  | { readonly kind: "interval"; readonly fromMs: number; readonly toMs: number };

/**
 * Matchers are synchronous, pure checks over a freshly read, frozen value.
 * Use negative-value for zero counts or negated predicates; the kernel cannot infer
 * whether arbitrary matcher code has negative semantics.
 */
export type ObservationExpectation<T extends TraceValue> =
  | { readonly kind: "value"; readonly expected: TraceValue; readonly matches: (value: T) => boolean }
  | { readonly kind: "negative-value"; readonly expected: TraceValue;
      readonly matches: (value: T) => boolean; readonly completeness: CompletenessRequirement }
  | { readonly kind: "absent"; readonly completeness: CompletenessRequirement };

export interface AssertionClock {
  now(): number;
  sleep(durationMs: number): Promise<void>;
}

export interface ObservationAssertionOptions<T extends TraceValue> {
  readonly expectation: ObservationExpectation<T>;
  readonly timeoutMs: number;
  /** Positive milliseconds between attempts, capped at the remaining budget. Default: 50. */
  readonly pollIntervalMs?: number;
  readonly clock?: AssertionClock;
  readonly criterionId?: string;
  readonly evidenceIds?: readonly string[];
}

export interface ObservationAssertionResult<T extends TraceValue> {
  readonly status: "passed" | "failed" | "timedOut";
  readonly expectationKind: ObservationExpectation<T>["kind"];
  readonly expected: TraceValue;
  readonly completeness?: CompletenessRequirement;
  /** Last read, including unknown/read-failed. Null when no read could start. */
  readonly actual: ObservationAttempt<T> | null;
  /** Last available/absent read; later read failures do not erase it. */
  readonly lastValidObservation: ObservationAttempt<T> | null;
  readonly lastReadError: {
    readonly attempt: number;
    /** Null when the read completed but its completion time could not be sampled. */
    readonly elapsedMs: number | null;
    readonly error: AssertionFailure;
  } | null;
  readonly failure: AssertionFailure | null;
  readonly attempts: number;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  /** Uses the last confirmed clock value when failure.code is clockFailed. */
  readonly elapsedMs: number;
  readonly pollIntervalMs: number;
  readonly criterionId?: string;
  readonly evidenceIds: readonly string[];
}
