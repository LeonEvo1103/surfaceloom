import assert from "node:assert/strict";
import test from "node:test";
import { assertObservation, ObservationAssertionError, waitForObservation } from "../src/assertion.js";
import { executeCase } from "../src/execute.js";
import type { Observation } from "../src/observation.js";
import { spec, validReport } from "./support.js";

function fakeTime(start = 0) {
  let now = start;
  const sleeps: number[] = [];
  return { sleeps, advance: (ms: number) => { now += ms; },
    clock: { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; } } };
}

test("each attempt rereads changing state and records criterion, evidence, and timing", async () => {
  const time = fakeTime(100);
  const calls: number[] = [];
  const result = await waitForObservation(({ attempt, startedAtMs, deadlineMs, remainingMs }) => {
    calls.push(attempt);
    assert.equal(startedAtMs, 100 + (attempt - 1) * 5);
    assert.equal(deadlineMs, 120);
    assert.equal(remainingMs, 20 - (attempt - 1) * 5);
    return { state: "available", value: attempt === 3 ? "ready" : "pending", evidenceIds: [`read.${attempt}`] };
  }, { expectation: { kind: "value", expected: "ready", matches: (value) => value === "ready" },
    timeoutMs: 20, pollIntervalMs: 5, clock: time.clock, criterionId: "ready-state", evidenceIds: ["initial"] });
  assert.equal(result.status, "passed");
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(time.sleeps, [5, 5]);
  assert.equal(result.elapsedMs, 10);
  assert.equal(result.criterionId, "ready-state");
  assert.deepEqual(result.evidenceIds, ["initial", "read.1", "read.2", "read.3"]);
  assert.deepEqual(result.actual?.observation, { state: "available", value: "ready", evidenceIds: ["read.3"] });
});

test("absence needs the requested complete barrier and never uses unknown or failed reads", async () => {
  const time = fakeTime();
  const observations: Observation<number>[] = [
    { state: "absent" },
    { state: "absent", completeness: { kind: "barrier", id: "run.done", complete: false } },
    { state: "absent", completeness: { kind: "barrier", id: "other.done", complete: true } },
    { state: "unknown", reason: "truncated stream" },
    { state: "read-failed", error: new Error("ledger unavailable") },
    { state: "absent", completeness: { kind: "barrier", id: "run.done", complete: true }, evidenceIds: ["ledger.complete"] },
  ];
  const result = await waitForObservation(({ attempt }) => observations[attempt - 1]!, {
    expectation: { kind: "absent", completeness: { kind: "barrier", id: "run.done" } },
    timeoutMs: 60, pollIntervalMs: 10, clock: time.clock,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.attempts, 6);
  assert.equal(result.lastReadError?.attempt, 5);
  assert.match(result.lastReadError?.error.message ?? "", /ledger unavailable/);
  assert.deepEqual(result.completeness, { kind: "barrier", id: "run.done" });
});

test("zero-count assertions cannot pass from incomplete available snapshots", async () => {
  const time = fakeTime();
  let checks = 0;
  const result = await waitForObservation(() => ({ state: "available", value: 0 }), {
    expectation: { kind: "negative-value", expected: 0, matches: () => { checks += 1; return true; },
      completeness: { kind: "barrier", id: "run.done" } },
    timeoutMs: 10, pollIntervalMs: 5, clock: time.clock,
  });
  assert.equal(result.status, "timedOut");
  assert.equal(checks, 0);
  const passed = await waitForObservation(() => ({ state: "available", value: 0,
    completeness: { kind: "barrier", id: "run.done", complete: true } }), {
    expectation: { kind: "negative-value", expected: 0, matches: (value) => value === 0,
      completeness: { kind: "barrier", id: "run.done" } },
    timeoutMs: 10, clock: time.clock,
  });
  assert.equal(passed.status, "passed");
});

test("negative intervals require full coverage with no claims from the future", async () => {
  const time = fakeTime(100);
  const result = await waitForObservation(({ attempt }) => ({ state: "absent",
    completeness: { kind: "interval", fromMs: attempt === 1 ? 100 : 90, toMs: 110, complete: true } }), {
    expectation: { kind: "absent", completeness: { kind: "interval", fromMs: 90, toMs: 110 } },
    timeoutMs: 20, pollIntervalMs: 5, clock: time.clock,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.attempts, 3);
  assert.equal(result.elapsedMs, 10);
});

test("timeout keeps the last valid observation and last read error after later unknown state", async () => {
  const time = fakeTime();
  const result = await waitForObservation(({ attempt }) => {
    if (attempt === 3) throw new Error("read broke");
    if (attempt === 4) return { state: "unknown", reason: "incomplete ledger" };
    return { state: "available", value: attempt };
  }, { expectation: { kind: "value", expected: 99, matches: (value) => value === 99 },
    timeoutMs: 15, pollIntervalMs: 4, clock: time.clock });
  assert.equal(result.status, "timedOut");
  assert.equal(result.expected, 99);
  assert.equal(result.attempts, 4);
  assert.equal(result.elapsedMs, 15);
  assert.equal(result.actual?.observation.state, "unknown");
  assert.deepEqual(result.lastValidObservation?.observation, { state: "available", value: 2, evidenceIds: [] });
  assert.equal(result.lastReadError?.attempt, 3);
  assert.equal(result.lastReadError?.elapsedMs, 8);
  assert.equal(result.lastReadError?.error.message, "read broke");
  assert.deepEqual(time.sleeps, [4, 4, 4, 3]);
});

test("read exceptions can recover while preserving their diagnostic", async () => {
  const time = fakeTime();
  const result = await waitForObservation(({ attempt }) => {
    if (attempt === 1) throw new Error("temporary disconnect");
    return { state: "available", value: true };
  }, { expectation: { kind: "value", expected: true, matches: (value) => value === true },
    timeoutMs: 10, pollIntervalMs: 2, clock: time.clock });
  assert.equal(result.status, "passed");
  assert.equal(result.lastReadError?.error.message, "temporary disconnect");
});

test("matcher failures retain expected, actual, and evidence instead of retrying the matcher", async () => {
  const time = fakeTime();
  let calls = 0;
  const result = await waitForObservation(() => ({ state: "available", value: 2, evidenceIds: ["read.evidence"] }), {
    expectation: { kind: "value", expected: 3, matches: () => { calls += 1; throw new Error("check failed"); } },
    timeoutMs: 10, clock: time.clock,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.code, "matcherFailed");
  assert.equal(result.expected, 3);
  assert.equal(result.actual?.observation.state, "available");
  assert.deepEqual(result.evidenceIds, ["read.evidence"]);
  assert.equal(calls, 1);
});

test("async matchers fail structurally and rejected promises do not become unhandled rejections", async () => {
  const time = fakeTime();
  for (const matches of [() => Promise.resolve(true), () => Promise.reject(new Error("async matcher failed"))]) {
    const result = await waitForObservation(() => ({ state: "available", value: true }), {
      expectation: { kind: "value", expected: true, matches: matches as never },
      timeoutMs: 10, clock: time.clock,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failure?.code, "matcherFailed");
    assert.match(result.failure?.message ?? "", /must return a boolean/);
  }
});

test("assertObservation throws structured details and records failure through context.criterion", async () => {
  const time = fakeTime();
  let caught: unknown;
  const report = await executeCase({ spec: spec(), run: async (context) => {
    await context.criterion("verified", async () => {
      try {
        await assertObservation(() => ({ state: "unknown", reason: "no trustworthy read" }), {
          expectation: { kind: "value", expected: true, matches: (value) => value === true },
          timeoutMs: 5, clock: time.clock, criterionId: "verified", evidenceIds: ["probe"] });
      } catch (error) { caught = error; throw error; }
    });
  } }, { platform: "web" });
  assert.ok(caught instanceof ObservationAssertionError);
  assert.equal(caught.result.status, "timedOut");
  assert.equal(caught.result.criterionId, "verified");
  assert.deepEqual(caught.result.evidenceIds, ["probe"]);
  assert.equal(report.result.status, "failed");
  validReport(report);
});
