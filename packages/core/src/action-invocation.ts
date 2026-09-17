import { types } from "node:util";

const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const reasonGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")?.get;
const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;

/** Immutable facts for one resolution-to-submit path. */
export interface ElementActionInvocationContext {
  readonly startedAt: number;
  readonly precheckDeadlineAt?: number;
  readonly signal?: AbortSignal;
}

export function assertAbortSignal(value: unknown): asserts value is AbortSignal {
  if (abortedGetter === undefined) throw new Error("AbortSignal is unavailable.");
  if ((typeof value === "object" || typeof value === "function") && value !== null
    && types.isProxy(value)) {
    throw new Error("Action signal must be a native, non-Proxy AbortSignal.");
  }
  try {
    Reflect.apply(abortedGetter, value, []);
  } catch {
    throw new Error("Action signal must be a native AbortSignal.");
  }
}

export function createInvocationContext(
  startedAt: number,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): ElementActionInvocationContext {
  return Object.freeze({ startedAt,
    ...(timeoutMs === undefined ? {} : { precheckDeadlineAt: startedAt + timeoutMs }),
    ...(signal === undefined ? {} : { signal }) });
}

export function assertInvocationMaySubmit(
  context: ElementActionInvocationContext,
): void {
  throwIfAborted(context.signal);
  if (context.precheckDeadlineAt !== undefined && monotonicNow() >= context.precheckDeadlineAt) {
    throw resolutionTimeoutError(context.precheckDeadlineAt - context.startedAt);
  }
}

export function awaitActionResolution<T>(
  pending: Promise<T>,
  timeoutMs: number | undefined,
  startedAt: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (isAborted(signal)) {
    void pending.catch(() => undefined);
    return Promise.reject(abortReason(signal!));
  }
  if (timeoutMs === undefined && signal === undefined) return pending;
  const timeout = timeoutMs === undefined ? undefined : timeoutMs - (monotonicNow() - startedAt);
  if (timeout !== undefined && timeout <= 0) {
    void pending.catch(() => undefined);
    return Promise.reject(resolutionTimeoutError(timeoutMs!));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (signal !== undefined) Reflect.apply(removeEventListener, signal, ["abort", onAbort]);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal!)));
    if (timeout !== undefined) {
      timer = setTimeout(() => finish(() => reject(resolutionTimeoutError(timeoutMs!))), timeout);
    }
    if (signal !== undefined) {
      Reflect.apply(addEventListener, signal, ["abort", onAbort, { once: true }]);
    }
    pending.then(
      (value) => timeoutMs !== undefined && monotonicNow() - startedAt >= timeoutMs
        ? finish(() => reject(resolutionTimeoutError(timeoutMs)))
        : finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (isAborted(signal)) throw abortReason(signal!);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && Reflect.apply(abortedGetter!, signal, []) === true;
}

function abortReason(signal: AbortSignal): unknown {
  const reason = reasonGetter === undefined ? undefined : Reflect.apply(reasonGetter, signal, []);
  return reason ?? new DOMException("The action was aborted.", "AbortError");
}

function resolutionTimeoutError(timeoutMs: number): Error {
  return new Error(`Actionability resolution timed out after ${timeoutMs}ms.`);
}

function monotonicNow(): number { return globalThis.performance.now(); }
