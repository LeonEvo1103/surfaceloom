import type { TraceValue } from "@surfaceloom/core";
import type { AssertionFailure } from "./assertion-contracts.js";

/** A provider declaration, not a proof synthesized from repeated empty snapshots. */
export type ObservationCompleteness =
  | { readonly kind: "barrier"; readonly id: string; readonly complete: boolean }
  | { readonly kind: "interval"; readonly fromMs: number; readonly toMs: number;
      readonly complete: boolean };

interface ObservationMetadata {
  readonly evidenceIds?: readonly string[];
}

export type Observation<T extends TraceValue> = ObservationMetadata & (
  | { readonly state: "available"; readonly value: T; readonly completeness?: ObservationCompleteness }
  | { readonly state: "absent"; readonly completeness?: ObservationCompleteness }
  | { readonly state: "unknown"; readonly reason: string }
  | { readonly state: "read-failed"; readonly error: unknown }
);

export type ObservationSnapshot<T extends TraceValue> = Exclude<Observation<T>, { state: "read-failed" }>
  | (ObservationMetadata & { readonly state: "read-failed"; readonly error: AssertionFailure });

export interface ObservationReadContext {
  /** One-based invocation count. A reader must perform a new read on every call. */
  readonly attempt: number;
  readonly startedAtMs: number;
  /** Absolute monotonic deadline in the supplied clock's time domain. */
  readonly deadlineMs: number;
  readonly remainingMs: number;
}

/**
 * Only callable readers are accepted, never a fixed value or already-started promise.
 * Return a fresh envelope per invocation. Reusing an envelope is rejected; the kernel
 * cannot prove that a provider actually reread its source or honestly declared completeness.
 * Readers are observations only: do not place action dispatch or retries inside them.
 */
export type ObservationReader<T extends TraceValue> = (
  context: ObservationReadContext,
) => Observation<T> | Promise<Observation<T>>;

export interface ObservationAttempt<T extends TraceValue> {
  readonly attempt: number;
  readonly startedAtMs: number;
  /** Null when the reader returned but its completion clock read failed. */
  readonly finishedAtMs: number | null;
  readonly observation: ObservationSnapshot<T>;
}
