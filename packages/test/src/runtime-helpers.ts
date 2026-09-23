import type { TraceValue } from "@surfaceloom/core";
import { waitForObservation } from "./assertion.js";
import type { AssertionClock, AssertionFailure, ObservationAssertionResult } from "./assertion-contracts.js";
import type { DeadlineTaskContext, DeadlineTaskOutcome } from "./deadline-contracts.js";
import { startDeadlineTask } from "./deadline.js";
import { attachErrorDiagnostic, errorSummary } from "./errors.js";
import type {
  BoundedDiagnosticContext, BoundedDiagnosticOptions, BoundedDiagnosticResult,
  BoundedObservationOptions, BoundedObservationReader, BoundedObservationResult, RuntimeHelperClock,
} from "./runtime-helpers-contracts.js";

const boundedObservationResult = Symbol.for("@surfaceloom/test/bounded-observation-result/v1");

const systemClock: RuntimeHelperClock = Object.freeze({
  now: () => performance.now(),
  schedule: (callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
});

/**
 * Bounds the whole observation wait, including a reader that never settles. The reader
 * receives the shared cancellation signal and a per-attempt remaining budget. Cancellation
 * prevents every later real read; an in-flight reader can remain unconfirmed in-process.
 */
export async function waitForObservationBounded<T extends TraceValue>(
  reader: BoundedObservationReader<T>, options: BoundedObservationOptions<T>,
): Promise<BoundedObservationResult<T>> {
  if (typeof reader !== "function") throw new Error("Bounded observations require a reader function.");
  const clock = options.clock ?? systemClock;
  const task = startDeadlineTask(async (deadline) => {
    const timeoutMs = deadline.remainingMs();
    const assertionClock = cancellationAwareClock(deadline, clock, deadline.deadlineMs - timeoutMs);
    const assertion = await waitForObservation(async (readContext) => {
      try {
        deadline.throwIfCancelled();
        const remainingMs = Math.min(readContext.remainingMs, deadline.remainingMs());
        if (remainingMs <= 0 || deadline.signal.aborted) throw deadline.signal.reason;
        const observation = await reader(Object.freeze({
          ...readContext, deadlineMs: deadline.deadlineMs, remainingMs, signal: deadline.signal,
        }));
        if (deadline.signal.aborted) {
          deadline.acknowledgeCancellation();
          throw deadline.signal.reason;
        }
        return observation;
      } catch (error) {
        if (deadline.signal.aborted) deadline.acknowledgeCancellation();
        throw error;
      }
    }, {
      expectation: options.expectation, timeoutMs, clock: assertionClock,
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.criterionId === undefined ? {} : { criterionId: options.criterionId }),
      ...(options.evidenceIds === undefined ? {} : { evidenceIds: options.evidenceIds }),
    });
    if (deadline.signal.aborted) deadline.acknowledgeCancellation();
    return assertion;
  }, {
    timeoutMs: options.timeoutMs,
    ...(options.cancellationGraceMs === undefined ? {} : { cancellationGraceMs: options.cancellationGraceMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    clock,
  });
  return observationResult(await task.outcome, task.context.startedAtMs, task.context.deadlineMs);
}

/** Await inside context.criterion(); non-passing results carry a structured bounded receipt. */
export async function assertObservationBounded<T extends TraceValue>(
  reader: BoundedObservationReader<T>, options: BoundedObservationOptions<T>,
): Promise<BoundedObservationResult<T>> {
  const result = await waitForObservationBounded(reader, options);
  if (result.status !== "passed") throw new BoundedObservationAssertionError(result);
  return result;
}

export class BoundedObservationAssertionError<T extends TraceValue = TraceValue> extends Error {
  constructor(readonly result: BoundedObservationResult<T>) {
    super(`Bounded observation assertion ${result.status}: ${result.failure?.message ?? "Expectation was not established."}`);
    this.name = "BoundedObservationAssertionError";
    Object.defineProperty(this, boundedObservationResult, { value: result });
    attachErrorDiagnostic(this, "boundedObservationAssertion", result);
  }
}

/**
 * Runs best-effort diagnostic capture under one deadline. Callback failures are returned,
 * not thrown, so a caller can preserve its original error. This helper does not publish
 * artifacts and its result is not a Case verdict.
 */
export async function captureBoundedDiagnostic<T>(
  callback: (context: BoundedDiagnosticContext) => T | PromiseLike<T>,
  options: BoundedDiagnosticOptions,
): Promise<BoundedDiagnosticResult<T>> {
  if (typeof callback !== "function") throw new Error("Diagnostic capture callback must be a function.");
  const task = startDeadlineTask((deadline) => Promise.resolve(callback(Object.freeze({
    signal: deadline.signal, remainingMs: deadline.remainingMs,
  }))).then(
    (payload) => { if (deadline.signal.aborted) deadline.acknowledgeCancellation(); return payload; },
    (error: unknown) => { if (deadline.signal.aborted) deadline.acknowledgeCancellation(); throw error; },
  ), options);
  const outcome = await task.outcome;
  const common = diagnosticCommon(outcome, task.context);
  if (outcome.status === "timedOut") return Object.freeze({ ...common, status: "timedOut" });
  if (outcome.status === "cancelled") return Object.freeze({ ...common, status: "cancelled" });
  if (outcome.status === "clockFailed") return Object.freeze({ ...common, status: "clockFailed",
    failure: failure("clockFailed", outcome.clockFailure?.message ?? "Diagnostic clock failed.") });
  const settlement = outcome.settlement;
  if (settlement?.status === "fulfilled") {
    return Object.freeze({ ...common, status: "captured", payload: settlement.value });
  }
  const cause = settlement?.status === "rejected" ? settlement.reason : new Error("Diagnostic callback did not settle.");
  return Object.freeze({ ...common, status: "failed", failure: summarized("diagnosticFailed", cause), cause });
}

function observationResult<T extends TraceValue>(outcome: DeadlineTaskOutcome<ObservationAssertionResult<T>>,
  startedAtMs: number, deadlineMs: number): BoundedObservationResult<T> {
  const settlement = outcome.settlement;
  const assertion = settlement?.status === "fulfilled" ? settlement.value : null;
  const cause = settlement?.status === "rejected" ? settlement.reason : null;
  const status = outcome.status === "settled"
    ? assertion?.status ?? "failed"
    : outcome.status;
  const result: BoundedObservationResult<T> = {
    status, stopStatus: outcome.stopStatus, started: outcome.started, startedAtMs, deadlineMs, assertion,
    failure: outcome.status === "settled"
      ? assertion?.failure ?? (cause === null ? null : summarized("boundedObservationFailed", cause))
      : cancellationFailure(outcome),
    cancellation: outcome.cancellation, cancellationAcknowledged: outcome.cancellationAcknowledged,
    clockFailure: outcome.clockFailure,
  };
  return Object.freeze(result);
}

function cancellationAwareClock(deadline: DeadlineTaskContext, clock: RuntimeHelperClock,
  initialNow: number): AssertionClock {
  let first = true;
  return Object.freeze({
    now: () => {
      if (first) { first = false; return initialNow; }
      if (deadline.signal.aborted) throw deadline.signal.reason;
      return clock.now();
    },
    sleep: (durationMs: number) => abortableSleep(clock, deadline.signal, durationMs),
  });
}

function abortableSleep(clock: RuntimeHelperClock, signal: AbortSignal, durationMs: number): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let scheduling = true;
    let firedSynchronously = false;
    let cancel: (() => void) | undefined;
    const done = (action: () => void) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", aborted);
      try { cancel?.(); } catch { /* The sleep is already logically closed. */ }
      action();
    };
    const aborted = () => done(() => reject(signal.reason));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    try {
      cancel = clock.schedule(() => {
        if (scheduling) { firedSynchronously = true; return; }
        done(resolve);
      }, durationMs);
      scheduling = false;
      if (typeof cancel !== "function") throw new Error("Runtime helper scheduler must return a cancellation function.");
      if (finished) { try { cancel(); } catch { /* The sleep already resolved from cancellation. */ } return; }
      if (firedSynchronously) throw new Error("Runtime helper scheduler must invoke callbacks asynchronously.");
      if (signal.aborted) aborted();
    } catch (error) {
      scheduling = false;
      done(() => reject(error));
    }
  });
}

function diagnosticCommon<T>(outcome: DeadlineTaskOutcome<T>, context: DeadlineTaskContext) {
  return { stopStatus: outcome.stopStatus, started: outcome.started,
    startedAtMs: context.startedAtMs, deadlineMs: context.deadlineMs,
    cancellation: outcome.cancellation, cancellationAcknowledged: outcome.cancellationAcknowledged,
    clockFailure: outcome.clockFailure } as const;
}

function cancellationFailure<T>(outcome: DeadlineTaskOutcome<T>): AssertionFailure | null {
  if (outcome.clockFailure !== null) return failure("clockFailed", outcome.clockFailure.message);
  return outcome.cancellation === null ? null
    : failure(outcome.cancellation.kind, outcome.cancellation.message);
}

function summarized(code: string, cause: unknown): AssertionFailure {
  return failure(code, errorSummary(code, cause).message);
}

function failure(code: string, message: string): AssertionFailure {
  return Object.freeze({ code, message });
}
