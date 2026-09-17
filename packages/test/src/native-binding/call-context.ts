import { types } from "node:util";
import type { CaseContext } from "../contracts.js";
import { NativeBindingError, type NativeBindingCallOptions } from "./contracts.js";

export interface NativeCallContext {
  beforeSubmit(): NativeBindingCallOptions;
  dispose(): void;
}

const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const reasonGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")?.get;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;

export function createNativeCallContext(
  context: CaseContext,
  explicit: Partial<NativeBindingCallOptions>,
  now: () => number = () => performance.now(),
): NativeCallContext {
  const signals = [context.signal, explicit.signal].filter((item): item is AbortSignal => item !== undefined);
  for (const signal of signals) assertNativeSignal(signal);
  context.throwIfCancelled();
  const startedAt = now();
  const requested = explicit.timeoutMs === undefined ? Number.POSITIVE_INFINITY
    : normalizeBudget(explicit.timeoutMs);
  const deadlineAt = startedAt + requested;
  if (effectiveBudget(context, deadlineAt, startedAt) <= 0) {
    throw new NativeBindingError("deadline", "No native dispatch budget remains.");
  }
  const controller = new AbortController();
  const abort = (signal: AbortSignal): void => controller.abort(nativeReason(signal));
  const listeners = signals.map((signal) => {
    if (nativeAborted(signal)) abort(signal);
    const listener = (): void => abort(signal);
    addListener.call(signal, "abort", listener, { once: true });
    return { signal, listener };
  });
  if (nativeAborted(controller.signal)) {
    disposeListeners(listeners);
    throw new NativeBindingError("aborted", "Native operation was aborted before dispatch.");
  }
  return Object.freeze({
    beforeSubmit: (): NativeBindingCallOptions => {
      context.throwIfCancelled();
      if (nativeAborted(controller.signal)) {
        throw new NativeBindingError("aborted", "Native operation was aborted before dispatch.");
      }
      const timeoutMs = effectiveBudget(context, deadlineAt, now());
      if (timeoutMs <= 0) throw new NativeBindingError("deadline", "No native dispatch budget remains.");
      return Object.freeze({ timeoutMs, signal: controller.signal });
    },
    dispose: () => disposeListeners(listeners),
  });
}

function assertNativeSignal(signal: AbortSignal): void {
  if (typeof signal !== "object" || signal === null || types.isProxy(signal)) {
    throw new NativeBindingError("aborted", "Native operation signal must be a native, non-Proxy AbortSignal.");
  }
  try { nativeAborted(signal); nativeReason(signal); }
  catch { throw new NativeBindingError("aborted", "Native operation signal must be a native AbortSignal."); }
}

function nativeAborted(signal: AbortSignal): boolean {
  if (abortedGetter === undefined) throw new Error("AbortSignal.aborted is unavailable.");
  return Boolean(abortedGetter.call(signal));
}
function nativeReason(signal: AbortSignal): unknown {
  if (reasonGetter === undefined) return undefined;
  return reasonGetter.call(signal);
}
function disposeListeners(listeners: readonly { signal: AbortSignal; listener: () => void }[]): void {
  for (const item of listeners) removeListener.call(item.signal, "abort", item.listener);
}
function effectiveBudget(context: CaseContext, deadlineAt: number, currentTime: number): number {
  const caseRemaining = Math.max(0, Math.floor(context.remainingMs()));
  const explicitRemaining = deadlineAt === Number.POSITIVE_INFINITY ? caseRemaining
    : Math.max(0, Math.floor(deadlineAt - currentTime));
  return Math.min(caseRemaining, explicitRemaining);
}
function normalizeBudget(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new NativeBindingError("deadline", "Native timeout must be a non-negative finite number.");
  }
  return Math.floor(value);
}
