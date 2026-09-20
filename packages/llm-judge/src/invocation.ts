import { types } from "node:util";
import { type JudgeInvocation, JudgeContractError } from "./contracts.js";

const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;

export interface InvocationSnapshot {
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
}

function dataValue(
  descriptors: Record<PropertyKey, PropertyDescriptor>,
  key: string,
  required: boolean,
): unknown {
  const descriptor = descriptors[key];
  if (descriptor === undefined) {
    if (required) throw new JudgeContractError(`invocation.${key}`, "is required");
    return undefined;
  }
  if (!("value" in descriptor)) {
    throw new JudgeContractError(`invocation.${key}`, "must be an own data property");
  }
  return descriptor.value;
}

export function snapshotInvocation(value: JudgeInvocation): InvocationSnapshot {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    throw new JudgeContractError("invocation", "must be a non-Proxy plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
    throw new JudgeContractError("invocation", "must not contain symbol keys");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new JudgeContractError("invocation", "must have a plain or null prototype");
  }
  const unexpected = Object.keys(descriptors).find((key) => key !== "deadlineAt" && key !== "signal");
  if (unexpected !== undefined) throw new JudgeContractError(`invocation.${unexpected}`, "is not allowed");
  const deadlineAt = dataValue(descriptors, "deadlineAt", true);
  if (!Number.isSafeInteger(deadlineAt) || (deadlineAt as number) < 0) {
    throw new JudgeContractError("invocation.deadlineAt", "must be an absolute epoch-millisecond integer");
  }
  const signal = dataValue(descriptors, "signal", false);
  if (signal !== undefined) {
    if (typeof signal !== "object" || signal === null || types.isProxy(signal) || abortedGetter === undefined) {
      throw new JudgeContractError("invocation.signal", "must be an AbortSignal or undefined");
    }
    try {
      abortedGetter.call(signal);
    } catch {
      throw new JudgeContractError("invocation.signal", "must be an AbortSignal or undefined");
    }
  }
  return Object.freeze({
    deadlineAt: deadlineAt as number,
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
  });
}

export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal === undefined ? false : abortedGetter!.call(signal) as boolean;
}

export function listenForAbort(signal: AbortSignal, listener: () => void): void {
  addEventListener.call(signal, "abort", listener, { once: true });
}

export function stopListeningForAbort(signal: AbortSignal, listener: () => void): void {
  removeEventListener.call(signal, "abort", listener);
}
