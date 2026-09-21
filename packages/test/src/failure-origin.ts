import { recordedObservationAssertionResult } from "./assertion.js";
import { SurfaceProviderError } from "./surfaces/errors.js";

export type RunCaseV3FailureOrigin = "business" | "infrastructure" | "insufficient" | null;

export function mergeFailureOrigins(left: RunCaseV3FailureOrigin,
  right: RunCaseV3FailureOrigin): RunCaseV3FailureOrigin {
  if (left === "infrastructure" || right === "infrastructure") return "infrastructure";
  if (left === "business" || right === "business") return "business";
  if (left === "insufficient" || right === "insufficient") return "insufficient";
  return null;
}

export function recordedFailureOrigin(phase: string, error: unknown,
  criterionLinked: boolean): Exclude<RunCaseV3FailureOrigin, "insufficient" | null> {
  if (phase !== "criterion" && !(phase === "step" && criterionLinked)) return "infrastructure";
  if (safeInstanceOf(error, SurfaceProviderError)) return "infrastructure";
  const result = recordedObservationAssertionResult(error);
  if (result !== undefined) {
    const observation = result.actual?.observation;
    return result.status === "timedOut"
      && (observation?.state === "available" || observation?.state === "absent")
      ? "business" : "infrastructure";
  }
  return "business";
}

function safeInstanceOf<T>(value: unknown, constructor: new (...args: never[]) => T): value is T {
  try { return value instanceof constructor; } catch { return false; }
}
