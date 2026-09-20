import {
  type JudgeInvocation,
  type JudgeOutcome,
  type JudgeProvider,
  JudgeProviderError,
  type JudgeRequest,
} from "./contracts.js";
import { normalizeProviderOutcome } from "./outcome-validation.js";
import { normalizeJudgeRequest } from "./request-validation.js";
import { types } from "node:util";
import {
  isAborted,
  type InvocationSnapshot,
  listenForAbort,
  snapshotInvocation,
  stopListeningForAbort,
} from "./invocation.js";

function failure(kind: "aborted" | "deadlineExceeded", message: string): JudgeOutcome {
  return { status: "providerFailure", failure: { kind, message, retryable: false } };
}

function currentStop(snapshot: InvocationSnapshot): "aborted" | "deadlineExceeded" | undefined {
  if (isAborted(snapshot.signal)) return "aborted";
  if (Date.now() >= snapshot.deadlineAt) return "deadlineExceeded";
  return undefined;
}

function stopOutcome(reason: "aborted" | "deadlineExceeded"): JudgeOutcome {
  return reason === "aborted"
    ? failure("aborted", "Judge invocation was aborted")
    : failure("deadlineExceeded", "Judge deadline was exceeded");
}

function providerErrorData(error: unknown): { kind: unknown; retryable: unknown; providerMetadata: unknown } | undefined {
  if (typeof error !== "object" || error === null || types.isProxy(error)) return undefined;
  try {
    if (Object.getPrototypeOf(error) !== JudgeProviderError.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(error);
    for (const key of ["kind", "retryable", "providerMetadata"] as const) {
      const descriptor = descriptors[key];
      if (descriptor !== undefined && !("value" in descriptor)) return undefined;
    }
    return {
      kind: descriptors.kind?.value,
      retryable: descriptors.retryable?.value,
      providerMetadata: descriptors.providerMetadata?.value,
    };
  } catch {
    return undefined;
  }
}

function providerDiagnostic(kind: unknown): string {
  switch (kind) {
    case "authentication": return "Provider authentication failed";
    case "rateLimited": return "Provider rate limit was reached";
    case "server": return "Provider server failed";
    default: return "Provider invocation failed";
  }
}

export async function judge(
  provider: JudgeProvider,
  request: JudgeRequest,
  invocation: JudgeInvocation,
): Promise<JudgeOutcome> {
  const fixedInvocation = snapshotInvocation(invocation);
  const normalized = normalizeJudgeRequest(request);
  const validationBaseline = normalizeJudgeRequest(normalized);
  const providerRequest = normalizeJudgeRequest(normalized);
  const initialStop = currentStop(fixedInvocation);
  if (initialStop !== undefined) return stopOutcome(initialStop);
  const remaining = fixedInvocation.deadlineAt - Date.now();
  if (remaining <= 0) return failure("deadlineExceeded", "Judge deadline has elapsed");

  const controller = new AbortController();
  type RaceResult = { kind: "value"; value: unknown } | { kind: "error"; error: unknown } | { kind: "stop"; reason: "aborted" | "deadlineExceeded" };
  let finishStop: ((value: RaceResult) => void) | undefined;
  const stop = new Promise<RaceResult>((resolve) => { finishStop = resolve; });
  const onAbort = () => {
    controller.abort();
    finishStop?.({ kind: "stop", reason: "aborted" });
  };
  if (fixedInvocation.signal !== undefined) listenForAbort(fixedInvocation.signal, onAbort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reachDeadline = () => {
    const delay = fixedInvocation.deadlineAt - Date.now();
    if (delay > 0) {
      timer = setTimeout(reachDeadline, Math.min(delay, 2_147_483_647));
      return;
    }
    controller.abort();
    finishStop?.({ kind: "stop", reason: "deadlineExceeded" });
  };
  timer = setTimeout(reachDeadline, Math.min(remaining, 2_147_483_647));
  const providerCall: Promise<RaceResult> = Promise.resolve().then(async () => {
    const beforeDispatch = currentStop(fixedInvocation);
    if (beforeDispatch !== undefined) return { kind: "stop", reason: beforeDispatch };
    try {
      const supplied = provider.judge(
        providerRequest,
        { deadlineAt: fixedInvocation.deadlineAt, signal: controller.signal },
      );
      const value = types.isPromise(supplied) ? await supplied : supplied;
      const afterProvider = currentStop(fixedInvocation);
      return afterProvider === undefined
        ? { kind: "value", value }
        : { kind: "stop", reason: afterProvider };
    } catch (error) {
      const afterProvider = currentStop(fixedInvocation);
      return afterProvider === undefined
        ? { kind: "error", error }
        : { kind: "stop", reason: afterProvider };
    }
  });

  const settled = await Promise.race([providerCall, stop]);
  if (timer !== undefined) clearTimeout(timer);
  if (fixedInvocation.signal !== undefined) stopListeningForAbort(fixedInvocation.signal, onAbort);
  if (settled.kind === "stop") return stopOutcome(settled.reason);
  if (settled.kind === "error") {
    const providerError = providerErrorData(settled.error);
    if (providerError !== undefined) {
      const candidate = {
        status: "providerFailure",
        failure: {
          kind: providerError.kind,
          message: providerDiagnostic(providerError.kind),
          retryable: providerError.retryable,
        },
        ...(providerError.providerMetadata === undefined
          ? {}
          : { providerMetadata: providerError.providerMetadata }),
      };
      try {
        const outcome = normalizeProviderOutcome(candidate, validationBaseline);
        const afterValidation = currentStop(fixedInvocation);
        return afterValidation === undefined ? outcome : stopOutcome(afterValidation);
      } catch {
        const afterValidation = currentStop(fixedInvocation);
        if (afterValidation !== undefined) return stopOutcome(afterValidation);
        return {
          status: "providerFailure",
          failure: { kind: "invalidResponse", message: "Provider failure data was invalid", retryable: false },
        };
      }
    }
    return {
      status: "providerFailure",
      failure: { kind: "provider", message: "Provider invocation failed", retryable: false },
    };
  }
  const beforeValidation = currentStop(fixedInvocation);
  if (beforeValidation !== undefined) return stopOutcome(beforeValidation);
  try {
    const outcome = normalizeProviderOutcome(settled.value, validationBaseline);
    const afterValidation = currentStop(fixedInvocation);
    return afterValidation === undefined ? outcome : stopOutcome(afterValidation);
  } catch {
    const afterValidation = currentStop(fixedInvocation);
    if (afterValidation !== undefined) return stopOutcome(afterValidation);
    return {
      status: "providerFailure",
      failure: { kind: "invalidResponse", message: "Provider response failed contract validation", retryable: false },
    };
  }
}
