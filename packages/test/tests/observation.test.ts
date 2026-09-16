import assert from "node:assert/strict";
import test from "node:test";
import { waitForObservation } from "../src/assertion.js";
import type { ObservationAssertionOptions } from "../src/assertion-contracts.js";

function options(): ObservationAssertionOptions<number> {
  let now = 0;
  return { expectation: { kind: "value", expected: 2, matches: (value) => value === 2 },
    timeoutMs: 10, pollIntervalMs: 2,
    clock: { now: () => now, sleep: async (ms: number) => { now += ms; } } };
}

test("fixed snapshots and already-started promises are not accepted as readers", async () => {
  await assert.rejects(waitForObservation({ state: "available", value: 2 } as never, options()), /reader/);
  await assert.rejects(waitForObservation(Promise.resolve({ state: "available", value: 2 }) as never, options()), /reader/);
});

test("a reader reusing a mutable old envelope fails and cannot rewrite the previous snapshot", async () => {
  const envelope = { state: "available" as const, value: 1 };
  const result = await waitForObservation(({ attempt }) => {
    if (attempt === 2) envelope.value = 2;
    return envelope;
  }, options());
  assert.equal(result.status, "failed");
  assert.equal(result.attempts, 2);
  assert.equal(result.failure?.code, "invalidObservation");
  assert.match(result.failure?.message ?? "", /old observation envelope/);
  assert.deepEqual(result.lastValidObservation?.observation, { state: "available", value: 1, evidenceIds: [] });
});

test("unknown and reader exceptions never invoke a value matcher", async () => {
  let matches = 0;
  const base = options();
  const error = Object.defineProperties(new Error(), {
    message: { get: () => { throw new Error("broken message getter"); } },
    name: { get: () => { throw new Error("broken name getter"); } },
  });
  const result = await waitForObservation(({ attempt }) => {
    if (attempt % 2) return { state: "unknown", reason: "no complete view" };
    throw error;
  }, { ...base, expectation: { kind: "value", expected: 2, matches: () => { matches += 1; return true; } } });
  assert.equal(result.status, "timedOut");
  assert.equal(matches, 0);
  assert.equal(result.lastValidObservation, null);
  assert.match(result.lastReadError?.error.message ?? "", /could not be read/);
});

test("providers can retain structured read-failure codes without treating them as observations", async () => {
  const result = await waitForObservation(() => ({ state: "read-failed", error: {
    code: "ledgerDisconnected", message: "The authoritative ledger could not be read.",
  } }), options());
  assert.equal(result.status, "timedOut");
  assert.equal(result.lastValidObservation, null);
  assert.deepEqual(result.lastReadError?.error, {
    code: "ledgerDisconnected", message: "The authoritative ledger could not be read.",
  });
});

test("invalid reader states, missing values, and hostile getters fail with structured read diagnostics", async () => {
  for (const observation of [
    { state: "unrecognized" }, { state: "available" }, { state: "unknown", reason: "" },
    { state: "available", value: NaN },
    { state: "absent", completeness: { kind: "barrier", id: "run.done", complete: "yes" } },
    Object.defineProperty({}, "state", { get: () => { throw new Error("broken observation getter"); } }),
  ]) {
    const result = await waitForObservation(() => observation as never, options());
    assert.equal(result.status, "failed");
    assert.equal(result.attempts, 1);
    assert.equal(result.lastReadError?.error.code, "invalidObservation");
  }
});

test("expected and observed JSON values are frozen copies, independent of later mutations", async () => {
  const expected = { count: 2 };
  const observed = { count: 1 };
  const base = options();
  const result = await waitForObservation(() => ({ state: "available", value: observed }), {
    ...base, expectation: { kind: "value", expected, matches: (value) => value.count === 1 },
  });
  expected.count = 100;
  observed.count = 100;
  assert.equal(result.status, "passed");
  assert.deepEqual(result.expected, { count: 2 });
  assert.deepEqual(result.actual?.observation, { state: "available", value: { count: 1 }, evidenceIds: [] });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.expected));
  assert.ok(Object.isFrozen(result.actual?.observation));
});
