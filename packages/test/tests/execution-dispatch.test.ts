import assert from "node:assert/strict";
import test from "node:test";
import {
  defineExecutionPlan, executeCase, type EffectDescriptor, type ExecutionClock,
  type ExecutionEnvironment,
} from "../src/index.js";
import { diagnostics, spec, validReport } from "./support.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
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
  return { clock, advance: (value: number) => {
    now = value;
    for (const alarm of [...alarms]) {
      if (alarm.at <= now) { alarms.delete(alarm); alarm.callback(); }
    }
  } };
}

const effect: EffectDescriptor = { resource: "case.effect", operation: "read", boundary: "local",
  securitySensitive: false, recovery: "notNeeded" };
const environment = (): ExecutionEnvironment => ({
  platform: "web", host: { os: "linux" }, surfaces: {},
});
const options = (clock?: ExecutionClock) => ({
  platform: "web" as const,
  plan: defineExecutionPlan({ spec: spec(), requirements: { surfaces: {} }, effects: [effect] }),
  environment: environment(), ...(clock === undefined ? {} : { timeoutMs: 10, clock }),
  policy: { grants: [{ resource: "case.effect", operations: ["read" as const] }] },
});

test("unawaited pending dispatch is bounded and late settlement cannot rewrite its report",
  { timeout: 1000 }, async () => {
    for (const lateFailure of [false, true]) {
      const time = manualClock();
      const actionStarted = deferred<void>();
      const action = deferred<void>();
      const execution = executeCase({ spec: spec(), run: async (context) => {
        void context.dispatch(effect, () => { actionStarted.resolve(); return action.promise; });
        await context.criterion("verified", () => assert.ok(true));
      } }, options(time.clock));
      await actionStarted.promise;
      time.advance(10);
      const report = await execution;
      const before = JSON.stringify(report);
      assert.equal(report.result.status, "timedOut");
      assert.match(diagnostics(report), /stopUnconfirmed/);
      if (lateFailure) action.reject(new Error("late dispatch rejection"));
      else action.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(JSON.stringify(report), before);
      validReport(report);
    }
  });

test("an unawaited immediate dispatch rejection is retained as effectDispatch", async () => {
  const report = await executeCase({ spec: spec(), run: async (context) => {
    void context.dispatch(effect, async () => { throw new Error("unawaited effect failed"); });
    await context.criterion("verified", () => assert.ok(true));
  } }, options());
  assert.equal(report.result.status, "failed");
  assert.deepEqual(report.result.error, { category: "effectDispatch", message: "unawaited effect failed" });
  assert.match(diagnostics(report), /unawaited effect failed/);
  validReport(report);
});

test("dispatch started by an unawaited step is included in the final lifecycle drain",
  { timeout: 1000 }, async () => {
    const time = manualClock();
    const bodyReturned = deferred<void>();
    const releaseStep = deferred<void>();
    const actionStarted = deferred<void>();
    const action = deferred<void>();
    const execution = executeCase({ spec: spec(), run: async (context) => {
      void context.step({ id: "late-dispatch", title: "迟到动作" }, async () => {
        await releaseStep.promise;
        void context.dispatch(effect, () => { actionStarted.resolve(); return action.promise; });
      });
      await context.criterion("verified", () => assert.ok(true));
      bodyReturned.resolve();
    } }, options(time.clock));
    await bodyReturned.promise;
    releaseStep.resolve();
    await actionStarted.promise;
    time.advance(10);
    const report = await execution;
    assert.equal(report.result.status, "timedOut");
    assert.match(diagnostics(report), /stopUnconfirmed/);
    action.resolve();
    validReport(report);
  });
