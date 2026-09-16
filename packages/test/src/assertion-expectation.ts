import type { TraceValue } from "@surfaceloom/core";
import type { CompletenessRequirement, ObservationExpectation } from "./assertion-contracts.js";
import type { ObservationSnapshot } from "./observation.js";
import { assertIdentifier } from "./definition.js";
import { interval, snapshotValue } from "./observation-values.js";

export function snapshotExpectation<T extends TraceValue>(input: ObservationExpectation<T>): ObservationExpectation<T> {
  const kind = input.kind;
  if (kind !== "value" && kind !== "negative-value" && kind !== "absent") throw new Error("Unknown assertion expectation kind.");
  const completeness = kind === "value" ? undefined : snapshotRequirement(input.completeness);
  if (kind === "absent") return Object.freeze({ kind, completeness: completeness! });
  const matches = input.matches;
  if (typeof matches !== "function") throw new Error("Value expectations need a synchronous matcher.");
  const expected = snapshotValue(input.expected);
  return kind === "value" ? Object.freeze({ kind, expected, matches })
    : Object.freeze({ kind, expected, matches, completeness: completeness! });
}

export function matchesExpectation<T extends TraceValue>(expectation: ObservationExpectation<T>,
  observation: ObservationSnapshot<T>, observedAtMs: number): boolean {
  if (observation.state === "unknown" || observation.state === "read-failed") return false;
  if (expectation.kind !== "value" && !hasCompleteness(observation, expectation.completeness, observedAtMs)) return false;
  if (expectation.kind === "absent") return observation.state === "absent";
  if (observation.state !== "available") return false;
  const result: unknown = expectation.matches(observation.value);
  if (typeof result !== "boolean") {
    // Observe a mistaken async matcher's rejection without pretending to cancel it.
    void Promise.resolve(result).catch(() => undefined);
    throw new Error("An observation matcher must return a boolean, not a promise or another value.");
  }
  return result;
}

function snapshotRequirement(input: CompletenessRequirement): CompletenessRequirement {
  if (input === null || typeof input !== "object") {
    throw new Error("Negative assertions require a completion barrier or a complete interval.");
  }
  const kind = input.kind;
  if (kind === "barrier") {
    const id = input.id;
    assertIdentifier(id);
    return Object.freeze({ kind, id });
  }
  if (kind === "interval") {
    const fromMs = input.fromMs;
    const toMs = input.toMs;
    interval(fromMs, toMs);
    return Object.freeze({ kind, fromMs, toMs });
  }
  throw new Error("Negative assertions require a completion barrier or a complete interval.");
}

function hasCompleteness<T extends TraceValue>(observation: ObservationSnapshot<T>,
  required: CompletenessRequirement, observedAtMs: number): boolean {
  if (observation.state !== "available" && observation.state !== "absent") return false;
  const proof = observation.completeness;
  if (proof === undefined || !proof.complete || proof.kind !== required.kind) return false;
  if (proof.kind === "barrier" && required.kind === "barrier") return proof.id === required.id;
  return proof.kind === "interval" && required.kind === "interval"
    && proof.fromMs <= required.fromMs && proof.toMs >= required.toMs && proof.toMs <= observedAtMs;
}
