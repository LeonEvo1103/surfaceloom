import assert from "node:assert/strict";
import test from "node:test";
import { waitForObservation } from "../src/assertion.js";
import type { AssertionClock, ObservationAssertionOptions } from "../src/assertion-contracts.js";

function fakeTime(start = 0) {
  let now = start;
  const sleeps: number[] = [];
  return { sleeps, advance: (ms: number) => { now += ms; },
    clock: { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } } };
}

function options(clock: AssertionClock, timeoutMs = 10): ObservationAssertionOptions<boolean> {
  return { expectation: { kind: "value", expected: true, matches: (value) => value },
    timeoutMs, pollIntervalMs: 4, clock };
}

test("poll sleeps stop at the exact remaining deadline and no reader starts there", async () => {
  const time = fakeTime();
  const started: number[] = [];
  const result = await waitForObservation(({ startedAtMs }) => {
    started.push(startedAtMs);
    return { state: "available", value: false };
  }, options(time.clock));
  assert.equal(result.status, "timedOut");
  assert.deepEqual(started, [0, 4, 8]);
  assert.deepEqual(time.sleeps, [4, 4, 2]);
  assert.equal(result.deadlineMs, 10);
  assert.equal(result.elapsedMs, 10);
});

test("late reader success stays timedOut without matching or scheduling another attempt", async () => {
  const time = fakeTime();
  let checks = 0;
  const result = await waitForObservation(() => {
    time.advance(11);
    return { state: "available", value: true };
  }, { ...options(time.clock), expectation: { kind: "value", expected: true,
    matches: () => { checks += 1; return true; } } });
  assert.equal(result.status, "timedOut");
  assert.equal(result.attempts, 1);
  assert.equal(result.elapsedMs, 11);
  assert.equal(checks, 0);
  assert.deepEqual(time.sleeps, []);
  assert.equal(result.lastValidObservation?.observation.state, "available");
});

test("matcher time consumes the same deadline", async () => {
  const time = fakeTime();
  const result = await waitForObservation(() => ({ state: "available", value: true }), {
    ...options(time.clock), expectation: { kind: "value", expected: true, matches: () => {
      time.advance(11);
      return true;
    } },
  });
  assert.equal(result.status, "timedOut");
  assert.equal(result.elapsedMs, 11);
  assert.equal(result.attempts, 1);
});

test("a reader completed exactly at deadline may pass without a further read", async () => {
  const time = fakeTime();
  const result = await waitForObservation(() => {
    time.advance(10);
    return { state: "available", value: true };
  }, options(time.clock));
  assert.equal(result.status, "passed");
  assert.equal(result.elapsedMs, 10);
  assert.deepEqual(time.sleeps, []);
});

test("zero budget starts no observation", async () => {
  const time = fakeTime();
  const result = await waitForObservation(() => { assert.fail("zero-budget reader started"); }, options(time.clock, 0));
  assert.equal(result.status, "timedOut");
  assert.equal(result.attempts, 0);
  assert.equal(result.actual, null);
  assert.equal(result.elapsedMs, 0);
});

test("oversleep never triggers a late reader", async () => {
  let now = 0;
  const requested: number[] = [];
  const result = await waitForObservation(() => ({ state: "available", value: false }), options({
    now: () => now,
    sleep: async (ms) => { requested.push(ms); now = 50; },
  }));
  assert.equal(result.status, "timedOut");
  assert.equal(result.attempts, 1);
  assert.deepEqual(requested, [4]);
  assert.equal(result.elapsedMs, 50);
});

test("backwards clocks and sleepers with no progress fail instead of looping", async () => {
  for (const mode of ["backwards", "unchanged", "rejected"] as const) {
    let now = 1;
    const result = await waitForObservation(() => ({ state: "available", value: false }), options({
      now: () => now,
      sleep: async () => {
        if (mode === "backwards") now = 0;
        if (mode === "rejected") throw new Error("sleeper unavailable");
      },
    }));
    assert.equal(result.status, "failed", mode);
    assert.equal(result.attempts, 1, mode);
    assert.equal(result.failure?.code, "sleepFailed", mode);
    assert.equal(result.actual?.observation.state, "available", mode);
  }
});

test("invalid timing and missing negative completeness reject before reading", async () => {
  const time = fakeTime();
  const read = () => { assert.fail("invalid-config reader started"); };
  for (const timeoutMs of [-1, Infinity, NaN]) {
    await assert.rejects(waitForObservation(read, options(time.clock, timeoutMs)), /timeoutMs/);
  }
  for (const pollIntervalMs of [0, -1, Infinity, NaN]) {
    await assert.rejects(waitForObservation(read, { ...options(time.clock), pollIntervalMs }), /pollIntervalMs/);
  }
  await assert.rejects(waitForObservation(read, { ...options(time.clock),
    expectation: { kind: "absent" } as never }));
  await assert.rejects(waitForObservation(read, { ...options(time.clock), expectation: {
    kind: "absent", completeness: { kind: "interval", fromMs: 10, toMs: 5 },
  } }), /fromMs/);
});

test("a completion clock failure preserves the returned ledger error, evidence, and prior valid read", async () => {
  let now = 0;
  let clockBroken = false;
  const result = await waitForObservation(({ attempt }) => {
    if (attempt === 1) return { state: "available", value: false, evidenceIds: ["ledger.initial"] };
    clockBroken = true;
    return { state: "read-failed", error: { code: "ledgerDisconnected", message: "Ledger connection failed." },
      evidenceIds: ["ledger.failure"] };
  }, options({
    now: () => {
      if (clockBroken) throw new Error("completion clock failed");
      return now;
    },
    sleep: async (ms) => { now += ms; },
  }));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "clockFailed");
  assert.match(result.failure?.message ?? "", /completion clock failed/);
  assert.equal(result.actual?.observation.state, "read-failed");
  assert.equal(result.actual?.finishedAtMs, null);
  assert.equal(result.lastReadError?.error.code, "ledgerDisconnected");
  assert.equal(result.lastReadError?.elapsedMs, null);
  assert.deepEqual(result.evidenceIds, ["ledger.initial", "ledger.failure"]);
  assert.equal(result.lastValidObservation?.attempt, 1);
});

test("available observations survive a failed completion clock without claiming a completion time", async () => {
  let clockBroken = false;
  const result = await waitForObservation(() => {
    clockBroken = true;
    return { state: "available", value: true, evidenceIds: ["read.complete"] };
  }, options({ now: () => {
    if (clockBroken) throw new Error("clock failed");
    return 0;
  }, sleep: async () => assert.fail("clock failure must stop polling") }));
  assert.equal(result.status, "failed");
  assert.equal(result.lastValidObservation?.observation.state, "available");
  assert.equal(result.lastValidObservation?.finishedAtMs, null);
  assert.deepEqual(result.evidenceIds, ["read.complete"]);
});
