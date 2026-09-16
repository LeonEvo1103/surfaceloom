import type { TraceValue } from "@surfaceloom/core";
import { assertIdentifier } from "./definition.js";
import { attachErrorDiagnostic, errorSummary } from "./errors.js";
import { AssertionTimer } from "./assertion-clock.js";
import { matchesExpectation, snapshotExpectation } from "./assertion-expectation.js";
import type { AssertionFailure, ObservationAssertionOptions, ObservationAssertionResult } from "./assertion-contracts.js";
import type { ObservationAttempt, ObservationReader, ObservationSnapshot } from "./observation.js";
import { evidenceIds, snapshotObservation } from "./observation-values.js";

/**
 * Polls a reader, never an action or a cached snapshot. Invalid configuration rejects
 * before reading. Execution failures return structured results; read failures are retried.
 * No read starts at/after the deadline, sleeps use only the remaining budget, and a late
 * read/matcher cannot pass. A read completed exactly at the deadline may still pass.
 * Awaited readers/sleepers are not forcibly cancelled: a hung reader remains pending,
 * and a late completion can exceed timeoutMs in elapsed time (SL-P1-050 owns isolation).
 */
export async function waitForObservation<T extends TraceValue>(reader: ObservationReader<T>,
  options: ObservationAssertionOptions<T>): Promise<ObservationAssertionResult<T>> {
  if (typeof reader !== "function") throw new Error("Assertions require an observation reader, not a snapshot or promise.");
  const expectation = snapshotExpectation(options.expectation);
  const expected: TraceValue = expectation.kind === "absent" ? "absent" : expectation.expected;
  const criterionId = options.criterionId;
  if (criterionId !== undefined) assertIdentifier(criterionId);
  const linkedEvidence = new Set(evidenceIds(options.evidenceIds));
  const timer = new AssertionTimer(options.timeoutMs, options.pollIntervalMs, options.clock);
  const seen = new WeakSet<object>();
  let attempts = 0;
  let actual: ObservationAttempt<T> | null = null;
  let lastValidObservation: ObservationAttempt<T> | null = null;
  let lastReadError: ObservationAssertionResult<T>["lastReadError"] = null;
  let phase = "clockFailed";

  function finish(status: ObservationAssertionResult<T>["status"],
    failure: AssertionFailure | null = null): ObservationAssertionResult<T> {
    return Object.freeze({ status, expectationKind: expectation.kind, expected,
      ...(expectation.kind === "value" ? {} : { completeness: expectation.completeness }),
      actual, lastValidObservation, lastReadError, failure,
      attempts, startedAtMs: timer.startedAtMs, deadlineMs: timer.deadlineMs,
      elapsedMs: timer.currentMs - timer.startedAtMs, pollIntervalMs: timer.pollIntervalMs,
      ...(criterionId === undefined ? {} : { criterionId }),
      evidenceIds: Object.freeze([...linkedEvidence]),
    });
  }

  const timedOut = () => finish("timedOut", Object.freeze({
    code: "deadlineExceeded", message: "The expected observation was not established before the deadline.",
  }));

  try {
    while (true) {
      phase = "clockFailed";
      const startedAtMs = timer.read();
      if (startedAtMs >= timer.deadlineMs) return timedOut();
      attempts += 1;
      let observation: ObservationSnapshot<T>;
      let invalidRead = false;
      try {
        const raw = await reader(Object.freeze({ attempt: attempts, startedAtMs,
          deadlineMs: timer.deadlineMs, remainingMs: timer.deadlineMs - startedAtMs }));
        try {
          if (raw !== null && typeof raw === "object") {
            if (seen.has(raw)) throw new Error("The reader reused an old observation envelope.");
            seen.add(raw);
          }
          observation = snapshotObservation<T>(raw);
        } catch (error) {
          invalidRead = true;
          observation = failedRead("invalidObservation", error);
        }
      } catch (error) {
        observation = failedRead("readFailed", error);
      }
      let finishedAtMs: number | null = null;
      let clockFailure: AssertionFailure | undefined;
      try { finishedAtMs = timer.read(); } catch (error) {
        clockFailure = failureSummary("clockFailed", error);
      }
      actual = Object.freeze({ attempt: attempts, startedAtMs, finishedAtMs, observation });
      for (const id of observation.evidenceIds ?? []) linkedEvidence.add(id);
      if (observation.state === "available" || observation.state === "absent") lastValidObservation = actual;
      if (observation.state === "read-failed") {
        lastReadError = Object.freeze({ attempt: attempts,
          elapsedMs: finishedAtMs === null ? null : finishedAtMs - timer.startedAtMs, error: observation.error });
      }
      if (finishedAtMs === null) return finish("failed", clockFailure!);
      if (invalidRead && observation.state === "read-failed") return finish("failed", observation.error);
      if (finishedAtMs > timer.deadlineMs) return timedOut();
      phase = "matcherFailed";
      const matched = matchesExpectation(expectation, observation, finishedAtMs);
      phase = "clockFailed";
      if (timer.read() > timer.deadlineMs) return timedOut();
      if (matched) return finish("passed");
      if (timer.currentMs >= timer.deadlineMs) return timedOut();
      phase = "sleepFailed";
      await timer.pause();
    }
  } catch (error) {
    try { timer.read(); } catch { /* Preserve the first clock/matcher/sleeper failure. */ }
    return finish("failed", failureSummary(phase, error));
  }
}

function failureSummary(code: string, error: unknown): AssertionFailure {
  return Object.freeze({ code, message: errorSummary(code, error).message });
}

function failedRead(code: string, error: unknown): ObservationSnapshot<never> {
  return Object.freeze({ state: "read-failed", error: failureSummary(code, error) });
}

/** Details also survive context.criterion() in the existing step diagnostic JSON. */
export class ObservationAssertionError<T extends TraceValue = TraceValue> extends Error {
  constructor(readonly result: ObservationAssertionResult<T>) {
    super(`Observation assertion ${result.status} after ${result.attempts} attempts: ${result.failure?.message ?? "Unknown failure."}`);
    this.name = "ObservationAssertionError";
    attachErrorDiagnostic(this, "observationAssertion", result);
  }
}

/** Await inside context.criterion() to let the existing execution kernel record failure. */
export async function assertObservation<T extends TraceValue>(reader: ObservationReader<T>,
  options: ObservationAssertionOptions<T>): Promise<ObservationAssertionResult<T>> {
  const result = await waitForObservation(reader, options);
  if (result.status !== "passed") throw new ObservationAssertionError(result);
  return result;
}
