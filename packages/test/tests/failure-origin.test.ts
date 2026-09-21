import assert from "node:assert/strict";
import test from "node:test";

import {
  ObservationAssertionError, recordedObservationAssertionResult,
} from "../src/assertion.js";
import { recordedFailureOrigin } from "../src/failure-origin.js";
import type { ObservationAssertionResult } from "../src/assertion-contracts.js";

test("criterion classification distinguishes a business mismatch from observation infrastructure",
  () => {
    assert.equal(recordedFailureOrigin("criterion",
      new ObservationAssertionError(assertionResult("available")), true), "business");
    const readFailure = new ObservationAssertionError(assertionResult("read-failed"));
    assert.ok(recordedObservationAssertionResult(readFailure));
    assert.equal(recordedFailureOrigin("criterion", readFailure, true), "infrastructure");
    assert.equal(recordedFailureOrigin("effectDispatch", new Error("transport disconnected"),
      true), "infrastructure");
  });

function assertionResult(state: "available" | "read-failed"):
  ObservationAssertionResult<string> {
  const observation = state === "available"
    ? { state, value: "wrong", completeness: { state: "complete" as const }, evidenceIds: [] }
    : { state, error: { code: "readFailed", message: "transport disconnected" }, evidenceIds: [] };
  const attempt = { attempt: 1, startedAtMs: 0, finishedAtMs: 10, observation };
  return { status: "timedOut", expectationKind: "value", expected: "ready", actual: attempt,
    lastValidObservation: state === "available" ? attempt : null,
    lastReadError: state === "read-failed" ? { attempt: 1, elapsedMs: 10,
      error: observation.error } : null,
    failure: { code: "deadlineExceeded", message: "deadline" }, attempts: 1,
    startedAtMs: 0, deadlineMs: 10, elapsedMs: 10, pollIntervalMs: 1, evidenceIds: [] };
}
