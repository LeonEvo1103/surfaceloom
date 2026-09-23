import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import type { Observation } from "../src/observation.js";
import {
  assertObservationBounded, BoundedObservationAssertionError, waitForObservationBounded,
} from "../src/runtime-helpers.js";
import type { RuntimeHelperClock } from "../src/runtime-helpers-contracts.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const expectation = {
  kind: "value" as const, expected: true, matches: (value: boolean) => value,
};

test("a hung reader returns at the total deadline with an unconfirmed stop", { timeout: 1000 }, async () => {
  let context: { readonly signal: AbortSignal; readonly remainingMs: number } | undefined;
  const result = await waitForObservationBounded((readContext) => {
    context = readContext;
    return new Promise<Observation<boolean>>(() => {});
  }, { expectation, timeoutMs: 20 });
  assert.equal(result.status, "timedOut");
  assert.equal(result.stopStatus, "unconfirmed");
  assert.equal(result.assertion, null);
  assert.equal(result.cancellation?.kind, "deadline");
  assert.ok(context !== undefined && context.remainingMs > 0 && context.remainingMs <= 20);
  assert.equal(context?.signal.aborted, true);
});

test("late success cannot turn the receipt green or start another read", { timeout: 1000 }, async () => {
  const read = deferred<Observation<boolean>>();
  let calls = 0;
  const result = await waitForObservationBounded(() => {
    calls += 1;
    return calls === 1 ? read.promise : { state: "available", value: true };
  }, { expectation, timeoutMs: 15, pollIntervalMs: 1 });
  assert.equal(result.status, "timedOut");
  assert.equal(result.stopStatus, "unconfirmed");
  read.resolve({ state: "available", value: true });
  await nextTurn();
  assert.equal(calls, 1);
  assert.equal(result.status, "timedOut");
  assert.equal(result.assertion, null);
});

test("a late reader rejection is consumed and never causes a retry", { timeout: 1000 }, async () => {
  const read = deferred<Observation<boolean>>();
  let calls = 0;
  const result = await waitForObservationBounded(() => { calls += 1; return read.promise; }, {
    expectation, timeoutMs: 15, pollIntervalMs: 1,
  });
  read.reject(new Error("late reader failure"));
  await nextTurn();
  assert.equal(result.status, "timedOut");
  assert.equal(calls, 1);
});

test("external abort cancels the wait and a zero budget starts no reader", { timeout: 1000 }, async () => {
  const external = new AbortController();
  let calls = 0;
  const waiting = waitForObservationBounded(() => {
    calls += 1;
    return new Promise<Observation<boolean>>(() => {});
  }, { expectation, timeoutMs: 100, signal: external.signal });
  external.abort();
  const cancelled = await waiting;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.stopStatus, "unconfirmed");
  assert.equal(cancelled.cancellation?.kind, "external");
  assert.ok(calls <= 1);

  const timedOut = await waitForObservationBounded(() => {
    assert.fail("zero-budget reader started");
  }, { expectation, timeoutMs: 0 });
  assert.equal(timedOut.status, "timedOut");
  assert.equal(timedOut.stopStatus, "notStarted");
  assert.equal(timedOut.started, false);
});

test("early abort keeps the last real elapsed time when an in-flight reader cooperates", async () => {
  const external = new AbortController();
  let calls = 0;
  const waiting = waitForObservationBounded(({ signal }) => {
    calls += 1;
    return new Promise<Observation<boolean>>((resolve) => {
      signal.addEventListener("abort", () => resolve({ state: "available", value: true }), { once: true });
    });
  }, { expectation, timeoutMs: 60_000, cancellationGraceMs: 100, signal: external.signal });
  external.abort();
  const result = await waiting;
  assert.equal(result.status, "cancelled");
  assert.equal(result.stopStatus, "cooperativeStopped");
  assert.equal(result.failure?.code, "external");
  assert.ok((result.assertion?.elapsedMs ?? Infinity) < 1_000);
  assert.equal(result.assertion?.status, "failed");
  assert.equal(calls, 1);
});

test("negative assertions still require complete evidence and never match unknown or read-failed", async () => {
  let matches = 0;
  const reads: Observation<number>[] = [
    { state: "unknown", reason: "ledger truncated" },
    { state: "read-failed", error: new Error("ledger unavailable") },
    { state: "available", value: 0,
      completeness: { kind: "barrier", id: "run.done", complete: false } },
    { state: "available", value: 0,
      completeness: { kind: "barrier", id: "run.done", complete: true } },
  ];
  const result = await waitForObservationBounded(({ attempt }) => reads[attempt - 1]!, {
    expectation: { kind: "negative-value", expected: 0,
      matches: (value) => { matches += 1; return value === 0; },
      completeness: { kind: "barrier", id: "run.done" } },
    timeoutMs: 1_000, pollIntervalMs: 1,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.assertion?.attempts, 4);
  assert.equal(matches, 1);
  assert.equal(result.assertion?.lastReadError?.attempt, 2);
});

test("bounded assert throws its structured receipt", async () => {
  await assert.rejects(assertObservationBounded(() => ({ state: "unknown", reason: "not complete" }), {
    expectation, timeoutMs: 10,
  }), (error: unknown) => {
    assert.ok(error instanceof BoundedObservationAssertionError);
    assert.equal(error.result.status, "timedOut");
    return true;
  });
});

test("abort withdraws a long polling timer", { timeout: 1000 }, async () => {
  const active = new Set<ReturnType<typeof setTimeout>>();
  const clock: RuntimeHelperClock = {
    now: () => performance.now(),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(() => { active.delete(timer); callback(); }, delayMs);
      active.add(timer);
      return () => { clearTimeout(timer); active.delete(timer); };
    },
  };
  const external = new AbortController();
  const waiting = waitForObservationBounded(() => ({ state: "available", value: false }), {
    expectation, timeoutMs: 120_000, pollIntervalMs: 60_000, cancellationGraceMs: 50,
    signal: external.signal, clock,
  });
  await nextTurn();
  assert.ok(active.size >= 1);
  external.abort();
  const result = await waiting;
  assert.equal(result.status, "cancelled");
  assert.equal(result.stopStatus, "cooperativeStopped");
  assert.equal(result.failure?.code, "external");
  assert.ok((result.assertion?.elapsedMs ?? Infinity) < 1_000,
    "early cancellation must not fabricate elapsed time at the far deadline");
  assert.equal(result.assertion?.attempts, 1);
  assert.equal(active.size, 0);
});
