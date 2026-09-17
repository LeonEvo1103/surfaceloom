import assert from "node:assert/strict";
import test from "node:test";
import { DeadlineCancellationError, startDeadlineTask } from "../src/deadline.js";
import type { ExecutionClock } from "../src/deadline-contracts.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function manualClock() {
  let now = 0;
  const alarms = new Set<{ at: number; callback: () => void }>();
  const clock: ExecutionClock = { now: () => now, schedule: (callback, delayMs) => {
    const alarm = { at: now + delayMs, callback };
    alarms.add(alarm);
    return () => { alarms.delete(alarm); };
  } };
  return { clock, alarms, set: (value: number) => { now = value; },
    advance: (value: number) => {
      now = value;
      for (const alarm of [...alarms]) {
        if (alarm.at <= now) { alarms.delete(alarm); alarm.callback(); }
      }
    } };
}

test("completion before the deadline produces a frozen settlement and clears alarms", async () => {
  const time = manualClock();
  const value = { resource: true };
  const task = startDeadlineTask((context) => {
    assert.equal(context.remainingMs(), 10);
    context.throwIfCancelled();
    assert.equal(context.acknowledgeCancellation(), false);
    time.set(9);
    return value;
  }, { timeoutMs: 10, clock: time.clock });
  const result = await task.outcome;
  assert.equal(result.status, "settled");
  assert.equal(result.stopStatus, "settled");
  assert.equal(result.settlement?.status, "fulfilled");
  if (result.settlement?.status === "fulfilled") assert.equal(result.settlement.value, value);
  assert.equal(result.settlement?.observedAtMs, 9);
  assert.equal(await task.settled, result.settlement);
  assert.equal(task.cancel(), null);
  for (const snapshot of [task, task.context, result, result.settlement, task.snapshot()]) {
    assert.ok(Object.isFrozen(snapshot));
  }
  assert.equal(Object.isFrozen(value), false, "resource payload ownership remains with the caller");
  assert.equal(time.alarms.size, 0);
});

test("ordinary synchronous throws and rejected promises settle without cancellation", async () => {
  const error = new Error("body failure");
  for (const run of [() => { throw error; }, () => Promise.reject(error)]) {
    const task = startDeadlineTask(run, { timeoutMs: 10, clock: manualClock().clock });
    const result = await task.outcome;
    assert.equal(result.status, "settled");
    assert.equal(result.settlement?.status, "rejected");
    if (result.settlement?.status === "rejected") assert.equal(result.settlement.reason, error);
    assert.equal(result.cancellation, null);
  }
});

test("deadline wins exact-boundary races regardless of alarm versus promise callback order", async () => {
  for (const alarmFirst of [false, true]) {
    const time = manualClock();
    const work = deferred<number>();
    const task = startDeadlineTask(() => work.promise, { timeoutMs: 10, clock: time.clock });
    if (alarmFirst) time.advance(10);
    else time.set(10);
    work.resolve(42);
    const receipt = await task.settled;
    const result = await task.outcome;
    assert.equal(result.status, "timedOut");
    assert.equal(receipt.status, "fulfilled");
    assert.equal(receipt.observedAtMs, 10);
    assert.equal(receipt.cancellation?.kind, "deadline");
    assert.equal(task.context.signal.aborted, true);
  }
});

test("timeout ends waiting without claiming an uncooperative task stopped", { timeout: 1000 }, async () => {
  const time = manualClock();
  const task = startDeadlineTask(() => new Promise<never>(() => {}), { timeoutMs: 10, clock: time.clock });
  time.advance(10);
  const result = await task.outcome;
  assert.equal(result.status, "timedOut");
  assert.equal(result.stopStatus, "unconfirmed");
  assert.equal(result.settlement, null);
  assert.equal(task.snapshot().settlement, null);
  assert.equal(time.alarms.size, 0);
  assert.throws(() => task.context.throwIfCancelled(), DeadlineCancellationError);
});

test("late resolve and reject update only the real settlement receipt", async () => {
  for (const fail of [false, true]) {
    const time = manualClock();
    const work = deferred<number>();
    const task = startDeadlineTask(() => work.promise, { timeoutMs: 10, clock: time.clock });
    time.advance(10);
    const result = await task.outcome;
    time.set(20);
    if (fail) work.reject("late rejection");
    else work.resolve(42);
    const receipt = await task.settled;
    assert.equal(receipt.status, fail ? "rejected" : "fulfilled");
    assert.equal(receipt.observedAtMs, 20);
    assert.equal(task.snapshot().settlement, receipt);
    assert.equal(result.settlement, null);
    assert.equal(result.stopStatus, "unconfirmed");
    assert.equal(await task.outcome, result);
  }
});

test("cooperative stop requires both acknowledgment and actual callback settlement", async () => {
  const time = manualClock();
  const task = startDeadlineTask((context) => new Promise<void>((resolve) => {
    context.signal.addEventListener("abort", () => {
      assert.equal(context.acknowledgeCancellation(), true);
      assert.equal(context.acknowledgeCancellation(), true);
      resolve();
    });
  }), { timeoutMs: 10, cancellationGraceMs: 5, clock: time.clock });
  time.advance(10);
  const result = await task.outcome;
  assert.equal(result.status, "timedOut");
  assert.equal(result.stopStatus, "cooperativeStopped");
  assert.equal(result.cancellationAcknowledged, true);
  assert.equal(result.settlement?.status, "fulfilled");
  assert.equal(time.alarms.size, 0);
  assert.equal(task.context.acknowledgeCancellation(), false);
});

test("an acknowledgment followed by a hang remains unconfirmed after bounded grace", async () => {
  const time = manualClock();
  const task = startDeadlineTask((context) => {
    context.signal.addEventListener("abort", () => { context.acknowledgeCancellation(); });
    return new Promise<never>(() => {});
  }, { timeoutMs: 10, cancellationGraceMs: 5, clock: time.clock });
  time.advance(10);
  assert.equal(time.alarms.size, 1);
  time.advance(15);
  const result = await task.outcome;
  assert.equal(result.cancellationAcknowledged, true);
  assert.equal(result.stopStatus, "unconfirmed");
  assert.equal(result.settlement, null);
  assert.equal(time.alarms.size, 0);
});

test("settlement during grace without acknowledgment is settled, not cooperativeStopped", async () => {
  const time = manualClock();
  const work = deferred<number>();
  const task = startDeadlineTask(() => work.promise,
    { timeoutMs: 10, cancellationGraceMs: 5, clock: time.clock });
  time.advance(10);
  time.set(12);
  work.resolve(1);
  const result = await task.outcome;
  assert.equal(result.status, "timedOut");
  assert.equal(result.stopStatus, "settled");
  assert.equal(result.cancellationAcknowledged, false);
});

test("pre-aborted signals and zero budgets skip callback invocation with notStarted receipts", async () => {
  const external = new AbortController();
  external.abort({ privateValue: "not copied to diagnostics" });
  for (const options of [{ timeoutMs: 10, signal: external.signal }, { timeoutMs: 0 }]) {
    const task = startDeadlineTask(() => assert.fail("callback must not start"),
      { ...options, clock: manualClock().clock });
    const result = await task.outcome;
    assert.equal(result.started, false);
    assert.equal(result.stopStatus, "notStarted");
    assert.equal((await task.settled).status, "notStarted");
    assert.equal(result.status, options.timeoutMs === 0 ? "timedOut" : "cancelled");
  }
});

test("external abort and manual cancellation are first-wins, immutable, and idempotent", async () => {
  const time = manualClock();
  const external = new AbortController();
  const work = deferred<void>();
  const task = startDeadlineTask(() => work.promise,
    { timeoutMs: 10, signal: external.signal, clock: time.clock });
  time.set(2);
  external.abort();
  const cancellation = task.cancel("second reason");
  assert.equal(cancellation?.kind, "external");
  assert.equal(cancellation?.requestedAtMs, 2);
  assert.ok(Object.isFrozen(cancellation));
  assert.equal(task.cancel(), cancellation);
  work.resolve();
  assert.equal((await task.settled).cancellation, cancellation);
  assert.equal((await task.outcome).status, "cancelled");
  assert.equal(task.cancel("after settlement"), cancellation);
  assert.equal(time.alarms.size, 0);
});

test("options and provider methods are captured before invoking user code", async () => {
  const time = manualClock();
  const options = { timeoutMs: 10, cancellationGraceMs: 5, clock: time.clock };
  const work = deferred<void>();
  const task = startDeadlineTask(() => {
    options.timeoutMs = 100;
    options.cancellationGraceMs = 100;
    time.clock.now = () => NaN;
    time.clock.schedule = () => assert.fail("replaced scheduler used");
    return work.promise;
  }, options);
  time.advance(10);
  time.advance(15);
  assert.equal((await task.outcome).stopStatus, "unconfirmed");
  assert.equal(task.context.deadlineMs, 10);
  work.resolve();
  await task.settled;
});

test("malicious thenables cannot settle twice or create an unhandled late rejection", async () => {
  const task = startDeadlineTask(() => ({ then: (resolve: (value: number) => void,
    reject: (reason: unknown) => void) => {
    resolve(1); reject(new Error("ignored rejection")); resolve(2);
  } } as PromiseLike<number>), { timeoutMs: 10, clock: manualClock().clock });
  const receipt = await task.settled;
  assert.equal(receipt.status, "fulfilled");
  if (receipt.status === "fulfilled") assert.equal(receipt.value, 1);
  assert.equal((await task.outcome).settlement, receipt);
});

test("manual cancellation emits once and remains the cause after external abort", async () => {
  const external = new AbortController();
  let notifications = 0;
  const task = startDeadlineTask((context) => {
    context.signal.addEventListener("abort", () => { notifications += 1; });
    return new Promise<never>(() => {});
  }, { timeoutMs: 10, signal: external.signal, clock: manualClock().clock });
  const first = task.cancel("caller stopped execution");
  assert.equal(task.cancel("replacement"), first);
  external.abort();
  const result = await task.outcome;
  assert.equal(notifications, 1);
  assert.equal(result.cancellation?.kind, "requested");
  assert.equal(result.cancellation?.message, "caller stopped execution");
  assert.equal(result.stopStatus, "unconfirmed");
  assert.equal(task.context.signal.reason.cancellation, first);
});
