import assert from "node:assert/strict";
import test from "node:test";
import { startDeadlineTask } from "../src/deadline.js";
import { trackInProcessTask } from "../src/worker.js";
import type { ExecutionClock } from "../src/deadline-contracts.js";

function controlledClock() {
  let now = 0;
  let alarm: (() => void) | undefined;
  const clock: ExecutionClock = { now: () => now,
    schedule: (callback) => { alarm = callback; return () => { alarm = undefined; }; } };
  return { clock, expire: () => { now = 10; alarm?.(); } };
}

test("ordinary in-process completion and rejection are serialized without pretending worker isolation", async () => {
  for (const failure of [false, true]) {
    const task = startDeadlineTask(() => {
      if (failure) throw new Error("original task failure");
      return { privateValue: "do not serialize" };
    }, { timeoutMs: 10, clock: controlledClock().clock });
    const handle = trackInProcessTask(task, { externalEffects: "none" });
    const result = await handle.outcome;
    assert.equal(result.isolation, "inProcess");
    assert.equal(result.state, "settled");
    assert.equal(result.settlement?.status, failure ? "rejected" : "fulfilled");
    assert.equal(result.exitCode, null);
    assert.doesNotMatch(JSON.stringify(result), /privateValue/);
    assert.ok(Object.isFrozen(handle));
  }
});

test("non-cooperative closure timeout is bounded and remains unconfirmed", { timeout: 1000 }, async () => {
  const time = controlledClock();
  const task = startDeadlineTask(() => new Promise<never>(() => {}), { timeoutMs: 10, clock: time.clock });
  const handle = trackInProcessTask(task, { externalEffects: "none" });
  time.expire();
  const result = await handle.outcome;
  assert.equal(result.state, "unconfirmed");
  assert.equal(result.tainted, true);
  assert.equal(result.settlement, null);
  assert.equal(result.exitCode, null);
  assert.equal(result.failures[0]?.code, "stopUnconfirmed");
});

test("cooperative acknowledgment plus settlement confirms only the callback promise boundary", async () => {
  const time = controlledClock();
  const task = startDeadlineTask((context) => new Promise<void>((resolve) => {
    context.signal.addEventListener("abort", () => { context.acknowledgeCancellation(); resolve(); });
  }), { timeoutMs: 10, cancellationGraceMs: 5, clock: time.clock });
  const handle = trackInProcessTask(task, { externalEffects: "none" });
  time.expire();
  assert.equal((await handle.outcome).state, "cooperativeStopped");
  assert.equal((await handle.settled).settlement?.status, "fulfilled");
  assert.equal(handle.snapshot().exitCode, null);
});

test("late completion changes current state but preserves the unconfirmed outcome and sticky taint", async () => {
  const time = controlledClock();
  let resolve!: () => void;
  const task = startDeadlineTask(() => new Promise<void>((done) => { resolve = done; }),
    { timeoutMs: 10, clock: time.clock });
  const handle = trackInProcessTask(task, { externalEffects: "none" });
  time.expire();
  const result = await handle.outcome;
  resolve();
  const actual = await handle.settled;
  assert.equal(result.state, "unconfirmed");
  assert.equal(result.settlement, null);
  assert.equal(actual.state, "settled");
  assert.equal(actual.tainted, true);
  assert.equal(handle.snapshot().settlement?.status, "fulfilled");
});

test("cancelling a closure with possible external effects retains unknown effect state after settlement", async () => {
  let resolve!: () => void;
  const task = startDeadlineTask(() => new Promise<void>((done) => { resolve = done; }),
    { timeoutMs: 10, clock: controlledClock().clock });
  const options = { externalEffects: "possible" as const };
  const handle = trackInProcessTask(task, options);
  handle.cancel("caller stopped"); handle.cancel("duplicate");
  const result = await handle.outcome;
  assert.equal(result.externalEffects, "unknown");
  assert.equal(result.tainted, true);
  resolve();
  assert.equal((await handle.settled).externalEffects, "unknown");
});

test("explicit unknown effects remain tainted even after normal completion", async () => {
  const task = startDeadlineTask(() => 42, { timeoutMs: 10, clock: controlledClock().clock });
  const handle = trackInProcessTask(task, { externalEffects: "none" });
  handle.markExternalEffectsUnknown();
  const result = await handle.outcome;
  assert.equal(result.state, "settled");
  assert.equal(result.externalEffects, "unknown");
  assert.equal(result.tainted, true);
});

test("unstarted callbacks do not taint a scope merely because effects were declared possible", async () => {
  const task = startDeadlineTask(() => assert.fail("zero budget must skip callback"),
    { timeoutMs: 0, clock: controlledClock().clock });
  const handle = trackInProcessTask(task, { externalEffects: "possible" });
  const result = await handle.outcome;
  assert.equal(result.state, "notStarted");
  assert.equal(result.tainted, false);
  assert.equal(result.cancellationRequested, true);
});

test("acknowledgment alone cannot confirm that an in-process callback stopped", async () => {
  const time = controlledClock();
  const task = startDeadlineTask((context) => {
    context.signal.addEventListener("abort", () => { context.acknowledgeCancellation(); });
    return new Promise<never>(() => {});
  }, { timeoutMs: 10, clock: time.clock });
  const handle = trackInProcessTask(task, { externalEffects: "none" });
  time.expire();
  const result = await handle.outcome;
  assert.equal(result.state, "unconfirmed");
  assert.equal(result.settlement, null);
});
