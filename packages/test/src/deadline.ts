import { DeadlineTimer, deadlineDuration } from "./deadline-clock.js";
import type {
  DeadlineCancellation, DeadlineClockFailure, DeadlineTask, DeadlineTaskContext,
  DeadlineTaskOptions, DeadlineTaskOutcome, DeadlineTaskSnapshot, TaskSettleReceipt,
} from "./deadline-contracts.js";

export class DeadlineCancellationError extends Error {
  readonly cancellation: DeadlineCancellation;

  constructor(cancellation: DeadlineCancellation) {
    super(cancellation.message);
    this.name = "DeadlineCancellationError";
    this.cancellation = cancellation;
    Object.freeze(this);
  }
}

/**
 * SL-P1-051: bounds the caller's wait and requests cooperative cancellation.
 * Completion must be observed strictly before the deadline to win a boundary tie.
 * This cannot preempt synchronous JavaScript or stop detached work. Clock providers
 * must deliver scheduled callbacks; a hanging provider cannot provide a deadline.
 */
export function startDeadlineTask<T>(
  run: (context: DeadlineTaskContext) => T | PromiseLike<T>,
  options: DeadlineTaskOptions,
): DeadlineTask<T> {
  if (typeof run !== "function") throw new Error("Deadline task callback must be a function.");
  const graceMs = deadlineDuration(options.cancellationGraceMs ?? 0, "cancellationGraceMs");
  const externalSignal = options.signal;
  const timer = new DeadlineTimer(options.timeoutMs, options.clock);
  if (!Number.isFinite(timer.deadlineMs + graceMs)) throw new Error("Cancellation grace exceeds the finite clock range.");
  const controller = new AbortController();
  let started = false;
  let settling = false;
  let outcomeFinished = false;
  let cancellation: DeadlineCancellation | null = null;
  let clockFailure: DeadlineClockFailure | null = null;
  let settlement: TaskSettleReceipt<T> | null = null;
  let acknowledged = false;
  let disarm: (() => void) | undefined;
  let resolveOutcome!: (result: DeadlineTaskOutcome<T>) => void;
  let resolveSettled!: (result: TaskSettleReceipt<T>) => void;
  const outcome = new Promise<DeadlineTaskOutcome<T>>((resolve) => { resolveOutcome = resolve; });
  const settled = new Promise<TaskSettleReceipt<T>>((resolve) => { resolveSettled = resolve; });
  const snapshot = (): DeadlineTaskSnapshot<T> => Object.freeze({
    started, settlement, cancellation, cancellationAcknowledged: acknowledged, clockFailure,
  });
  const finish = () => {
    if (outcomeFinished) return;
    outcomeFinished = true;
    disarm?.();
    externalSignal?.removeEventListener("abort", externalAbort);
    const status = cancellation === null ? "settled"
      : cancellation.kind === "deadline" ? "timedOut"
      : cancellation.kind === "clockFailed" ? "clockFailed" : "cancelled";
    const stopStatus = settlement === null ? "unconfirmed"
      : settlement.status === "notStarted" ? "notStarted"
      : cancellation !== null && acknowledged ? "cooperativeStopped" : "settled";
    resolveOutcome(Object.freeze({ ...snapshot(), status, stopStatus }));
  };
  const clockFailed = (_error: unknown) => {
    clockFailure ??= Object.freeze({ code: "clockFailed", message: "Execution clock or scheduler failed." });
    requestCancellation("clockFailed", clockFailure.message);
    // A broken clock cannot safely measure additional cancellation grace.
    if (!settling) finish();
  };
  const requestCancellation = (kind: DeadlineCancellation["kind"], message: string): DeadlineCancellation | null => {
    if (cancellation !== null) return cancellation;
    if (settlement !== null) return null;
    cancellation = Object.freeze({ kind, requestedAtMs: timer.currentMs, message });
    disarm?.();
    externalSignal?.removeEventListener("abort", externalAbort);
    controller.abort(new DeadlineCancellationError(cancellation));
    if (!started) {
      settlement = Object.freeze({ status: "notStarted", observedAtMs: clockFailure === null ? timer.currentMs : null,
        cancellation });
      resolveSettled(settlement);
      finish();
    } else if (!settling) {
      if (graceMs === 0 || clockFailure !== null) finish();
      else {
        const graceDeadline = timer.currentMs + graceMs;
        if (!Number.isFinite(graceDeadline)) clockFailed(new Error("Cancellation grace overflowed."));
        else disarm = timer.arm(graceDeadline, finish, clockFailed);
      }
    }
    return cancellation;
  };
  const externalAbort = () => {
    sample();
    requestCancellation("external", "Execution was cancelled by the external signal.");
  };
  const sample = (): number | null => {
    try { return timer.read(); }
    catch (error) { clockFailed(error); return null; }
  };
  const remainingMs = () => {
    const now = sample();
    if (now === null) throw new Error(clockFailure!.message);
    if (now >= timer.deadlineMs) requestCancellation("deadline", "Execution deadline expired.");
    return Math.max(0, timer.deadlineMs - now);
  };
  const context: DeadlineTaskContext = Object.freeze({
    signal: controller.signal, startedAtMs: timer.startedAtMs, deadlineMs: timer.deadlineMs,
    remainingMs,
    throwIfCancelled: () => { remainingMs(); controller.signal.throwIfAborted(); },
    acknowledgeCancellation: () => {
      if (cancellation === null || settlement !== null) return false;
      acknowledged = true;
      return true;
    },
  });
  const complete = (result: { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }) => {
    if (settlement !== null) return;
    settling = true;
    const now = sample();
    if (now !== null && now >= timer.deadlineMs) requestCancellation("deadline", "Execution deadline expired.");
    settlement = Object.freeze({ ...result, observedAtMs: now, cancellation });
    settling = false;
    resolveSettled(settlement);
    finish();
  };
  const task: DeadlineTask<T> = Object.freeze({
    context, outcome, settled, snapshot,
    cancel: (message = "Execution cancellation requested.") => {
      if (typeof message !== "string") throw new Error("Cancellation message must be a string.");
      if (cancellation !== null || settlement !== null) return cancellation;
      sample();
      return requestCancellation("requested", message);
    },
  });
  if (externalSignal?.aborted) externalAbort();
  else {
    externalSignal?.addEventListener("abort", externalAbort, { once: true });
    disarm = timer.arm(timer.deadlineMs,
      () => requestCancellation("deadline", "Execution deadline expired."), clockFailed);
  }
  if (cancellation === null) {
    started = true;
    try {
      Promise.resolve(run(context)).then(
        (value) => complete({ status: "fulfilled", value }),
        (reason: unknown) => complete({ status: "rejected", reason }),
      );
    } catch (reason) { complete({ status: "rejected", reason }); }
  }
  return task;
}
