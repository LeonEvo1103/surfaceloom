import assert from "node:assert/strict";
import test from "node:test";
import { startDeadlineTask } from "../src/deadline.js";
import type { DeadlineTaskContext, ExecutionClock } from "../src/deadline-contracts.js";

function controlledClock() {
  let now = 1;
  const callbacks: (() => void)[] = [];
  const delays: number[] = [];
  const clock: ExecutionClock = { now: () => now, schedule: (callback, delayMs) => {
    callbacks.push(callback); delays.push(delayMs); return () => {};
  } };
  return { clock, delays, callbacks, set: (value: number) => { now = value; } };
}

test("backwards, non-finite, and stalled clocks fail closed without rescheduling loops", async () => {
  for (const next of [0, 1, NaN, Infinity]) {
    const time = controlledClock();
    const task = startDeadlineTask(() => new Promise<never>(() => {}),
      { timeoutMs: 10, cancellationGraceMs: 5, clock: time.clock });
    time.set(next);
    time.callbacks[0]!();
    const result = await task.outcome;
    assert.equal(result.status, "clockFailed");
    assert.equal(result.stopStatus, "unconfirmed");
    assert.equal(result.clockFailure?.code, "clockFailed");
    assert.equal(task.context.signal.aborted, true);
    assert.equal(time.callbacks.length, 1);
  }
});

test("early alarm with actual clock progress reschedules only the remaining budget", async () => {
  const time = controlledClock();
  const task = startDeadlineTask(() => new Promise<never>(() => {}), { timeoutMs: 10, clock: time.clock });
  time.set(4);
  time.callbacks[0]!();
  assert.deepEqual(time.delays, [10, 7]);
  time.set(11);
  time.callbacks[1]!();
  assert.equal((await task.outcome).status, "timedOut");
  time.callbacks[0]!();
  time.callbacks[1]!();
  assert.equal(time.callbacks.length, 2, "closed callbacks must stay inert");
});

test("long deadlines are chunked to Node's timer limit instead of overflowing to one millisecond", async () => {
  const time = controlledClock();
  const task = startDeadlineTask(() => new Promise<never>(() => {}),
    { timeoutMs: 2_147_483_650, clock: time.clock });
  assert.deepEqual(time.delays, [2_147_483_647]);
  time.set(2_147_483_648);
  time.callbacks[0]!();
  assert.deepEqual(time.delays, [2_147_483_647, 3]);
  task.cancel();
  assert.equal((await task.outcome).status, "cancelled");
});

test("scheduler throw and synchronous callback fail before the task starts", async () => {
  for (const schedule of [() => { throw new Error("scheduler unavailable"); },
    (callback: () => void) => { callback(); return () => {}; }]) {
    const task = startDeadlineTask(() => assert.fail("bad scheduler must not start task"),
      { timeoutMs: 10, clock: { now: () => 0, schedule } });
    const result = await task.outcome;
    assert.equal(result.status, "clockFailed");
    assert.equal(result.stopStatus, "notStarted");
    assert.equal((await task.settled).observedAtMs, null);
  }
});

test("a clock failure at settlement retains fulfilled and rejected task results", async () => {
  for (const rejected of [false, true]) {
    let broken = false;
    const task = startDeadlineTask(() => {
      broken = true;
      if (rejected) throw new Error("actual task failure");
      return 42;
    }, { timeoutMs: 10, clock: { now: () => {
      if (broken) throw new Error("clock disconnected");
      return 0;
    }, schedule: () => () => {} } });
    const result = await task.outcome;
    assert.equal(result.status, "clockFailed");
    assert.equal(result.stopStatus, "settled");
    assert.equal(result.settlement?.status, rejected ? "rejected" : "fulfilled");
    assert.equal(result.settlement?.observedAtMs, null);
    if (result.settlement?.status === "rejected") assert.match(String(result.settlement.reason), /actual task failure/);
  }
});

test("clock failure during grace preserves the first cancellation cause", async () => {
  const time = controlledClock();
  const task = startDeadlineTask(() => new Promise<never>(() => {}),
    { timeoutMs: 10, cancellationGraceMs: 5, clock: time.clock });
  time.set(11);
  time.callbacks[0]!();
  time.set(10);
  time.callbacks[1]!();
  const result = await task.outcome;
  assert.equal(result.status, "timedOut");
  assert.equal(result.cancellation?.kind, "deadline");
  assert.equal(result.clockFailure?.code, "clockFailed");
  assert.equal(result.stopStatus, "unconfirmed");
});

test("remainingMs both observes expiry and cancels even before an alarm is delivered", async () => {
  const time = controlledClock();
  let context!: DeadlineTaskContext;
  const task = startDeadlineTask((input) => {
    context = input; return new Promise<never>(() => {});
  }, { timeoutMs: 10, clock: time.clock });
  time.set(11);
  assert.equal(context.remainingMs(), 0);
  assert.equal((await task.outcome).status, "timedOut");
});

test("a caught context clock error still cancels the execution waiter", async () => {
  const time = controlledClock();
  const task = startDeadlineTask((context) => {
    time.set(0);
    assert.throws(() => context.remainingMs());
    return new Promise<never>(() => {});
  }, { timeoutMs: 10, clock: time.clock });
  assert.equal((await task.outcome).status, "clockFailed");
});

test("invalid budgets and initial clock values reject before starting work", () => {
  const run = () => assert.fail("invalid input started task");
  for (const timeoutMs of [-1, NaN, Infinity]) {
    assert.throws(() => startDeadlineTask(run, { timeoutMs }), /timeoutMs/);
  }
  for (const cancellationGraceMs of [-1, NaN, Infinity]) {
    assert.throws(() => startDeadlineTask(run, { timeoutMs: 1, cancellationGraceMs }), /cancellationGraceMs/);
  }
  assert.throws(() => startDeadlineTask(run, { timeoutMs: Number.MAX_VALUE,
    clock: { now: () => Number.MAX_VALUE, schedule: () => () => {} } }), /finite clock range/);
  assert.throws(() => startDeadlineTask(run, { timeoutMs: 1,
    clock: { now: () => NaN, schedule: () => () => {} } }), /finite milliseconds/);
});

test("system clock bounds a hanging asynchronous task and observes later cooperative settlement", { timeout: 1000 }, async () => {
  const task = startDeadlineTask((context) => new Promise<void>((resolve) => {
    context.signal.addEventListener("abort", () => {
      context.acknowledgeCancellation(); resolve();
    });
  }), { timeoutMs: 5, cancellationGraceMs: 100 });
  const result = await task.outcome;
  assert.equal(result.status, "timedOut");
  assert.equal(result.stopStatus, "cooperativeStopped");
});
