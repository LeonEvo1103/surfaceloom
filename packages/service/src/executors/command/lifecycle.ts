import type { CommandChild, SignalAttemptReceipt } from "./contracts.js";

export type TerminationTrigger = "natural" | "abort" | "deadline" | "infrastructure";

export interface FirstEvent {
  readonly trigger: TerminationTrigger;
  readonly detail?: string;
}

export function waitForFirstEvent(
  exit: Promise<unknown>,
  failure: Promise<string>,
  signal: AbortSignal,
  deadlineAt: number,
  now: () => number,
): { readonly promise: Promise<FirstEvent>; readonly dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const abort = new Promise<FirstEvent>((resolve) => {
    abortListener = () => resolve({ trigger: "abort" });
    if (signal.aborted) abortListener();
    else signal.addEventListener("abort", abortListener, { once: true });
  });
  const deadline = new Promise<FirstEvent>((resolve) => {
    const check = (): void => {
      const remaining = deadlineAt - now();
      if (remaining <= 0) resolve({ trigger: "deadline" });
      else timer = setTimeout(check, remaining);
    };
    check();
  });
  const promise = Promise.race([
    exit.then((): FirstEvent => {
      if (signal.aborted) return { trigger: "abort" };
      if (now() >= deadlineAt) return { trigger: "deadline" };
      return { trigger: "natural" };
    }),
    failure.then((detail): FirstEvent => ({ trigger: "infrastructure", detail })),
    abort,
    deadline,
  ]);
  return {
    promise,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
    },
  };
}

export async function terminateOwnedProcess(
  child: CommandChild,
  exit: Promise<unknown>,
  hasExited: () => boolean,
  graceMs: number,
  forceMs: number,
  wallNow: () => Date,
): Promise<readonly SignalAttemptReceipt[]> {
  const receipts: SignalAttemptReceipt[] = [];
  if (!hasExited()) receipts.push(attemptSignal(child, "SIGTERM", wallNow));
  if (!hasExited()) await waitBounded(exit, graceMs);
  if (!hasExited()) receipts.push(attemptSignal(child, "SIGKILL", wallNow));
  if (!hasExited()) await waitBounded(exit, forceMs);
  return Object.freeze(receipts);
}

export async function waitBounded(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function attemptSignal(
  child: CommandChild,
  signal: "SIGTERM" | "SIGKILL",
  wallNow: () => Date,
): SignalAttemptReceipt {
  const attemptedAt = wallNow().toISOString();
  try {
    const accepted = child.kill(signal);
    return Object.freeze({ signal, attemptedAt, outcome: accepted ? "accepted" : "rejected" });
  } catch (error) {
    return Object.freeze({
      signal,
      attemptedAt,
      outcome: "threw",
      detail: error instanceof Error ? error.message : "Unknown signal failure.",
    });
  }
}
