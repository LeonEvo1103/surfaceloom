import assert from "node:assert/strict";
import test from "node:test";
import { defineFixture } from "@surfaceloom/core";
import {
  defineExecutionPlan, executeCase, type ExecutionClock, type ExecutionEnvironment,
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

const environment = (): ExecutionEnvironment => ({
  platform: "web", host: { os: "linux" }, surfaces: {},
});

test("plan/spec and environment/platform mismatches fail preflight before all lifecycle work", async () => {
  let setups = 0;
  let bodies = 0;
  let cleanups = 0;
  const fixture = defineFixture({ id: "guarded", setup: () => {
    setups += 1;
    return { value: true, teardown: () => { cleanups += 1; } };
  } });
  const definition = { spec: spec(), fixtures: [fixture], run: () => { bodies += 1; } };
  const mismatched = defineExecutionPlan({
    spec: { ...spec(), name: "不同但仍合法的用例名称" }, requirements: { surfaces: {} },
  });
  await assert.rejects(executeCase(definition, {
    platform: "web", plan: mismatched, environment: environment(),
  }), /invalidInput/);
  const matching = defineExecutionPlan({ spec: spec(), requirements: { surfaces: {} } });
  await assert.rejects(executeCase(definition, {
    platform: "web", plan: matching, environment: { ...environment(), platform: "macos", host: { os: "macos" } },
  }), /invalidInput/);
  assert.deepEqual({ setups, bodies, cleanups }, { setups: 0, bodies: 0, cleanups: 0 });
});

test("zero budget and pre-abort never start setup, body, or cleanup", async () => {
  for (const preAbort of [false, true]) {
    const calls: string[] = [];
    const signal = new AbortController();
    if (preAbort) signal.abort();
    const fixture = defineFixture({ id: "never", setup: () => {
      calls.push("setup");
      return { value: true, teardown: () => { calls.push("cleanup"); } };
    } });
    const report = await executeCase({ spec: spec(), fixtures: [fixture],
      run: () => { calls.push("body"); } }, {
      platform: "web", timeoutMs: preAbort ? 10 : 0,
      ...(preAbort ? { signal: signal.signal } : {}), clock: manualClock().clock,
    });
    assert.deepEqual(calls, []);
    assert.equal(report.result.status, preAbort ? "failed" : "timedOut");
    assert.match(diagnostics(report), /"state":"notStarted"/);
    validReport(report);
  }
});

test("late fixture setup cannot run the body or rewrite the unconfirmed report", { timeout: 1000 }, async () => {
  const time = manualClock();
  const setup = deferred<{ value: boolean; teardown: () => void }>();
  const events: string[] = [];
  const fixture = defineFixture({ id: "late", setup: () => setup.promise });
  const execution = executeCase({ spec: spec(), fixtures: [fixture],
    run: () => { events.push("body"); } }, { platform: "web", timeoutMs: 10, clock: time.clock });
  time.advance(10);
  const report = await execution;
  const before = JSON.stringify(report);
  assert.equal(report.result.status, "timedOut");
  assert.match(diagnostics(report), /"state":"unconfirmed"/);
  assert.match(diagnostics(report), /"reason":"producerUnconfirmed"/);
  setup.resolve({ value: true, teardown: () => { events.push("cleanup"); } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["cleanup"]);
  assert.equal(JSON.stringify(report), before);
  validReport(report);
});

test("a hanging body returns unconfirmed and late criterion work cannot mutate its report", { timeout: 1000 }, async () => {
  const time = manualClock();
  const body = deferred<void>();
  let retained: Parameters<Parameters<typeof executeCase>[0]["run"]>[0] | undefined;
  const execution = executeCase({ spec: spec(), run: (context) => {
    retained = context;
    return body.promise;
  } }, { platform: "web", timeoutMs: 10, clock: time.clock });
  time.advance(10);
  const report = await execution;
  const before = JSON.stringify(report);
  assert.equal(report.result.status, "timedOut");
  assert.match(diagnostics(report), /stopUnconfirmed/);
  assert.throws(() => retained?.criterion("verified", () => undefined), /no longer accepting/);
  let lateCleanup = 0;
  assert.throws(() => retained?.registerResource({ id: "too-late", ownership: "owned",
    cleanup: () => { lateCleanup += 1; return { status: "released" }; },
  }), /no longer accepting/);
  body.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lateCleanup, 0);
  assert.equal(JSON.stringify(report), before);
  validReport(report);
});

test("cooperative cancellation requires acknowledgment, settlement, and completed cleanup", { timeout: 1000 }, async () => {
  const time = manualClock();
  const started = deferred<void>();
  let cleaned = false;
  const fixture = defineFixture({ id: "cooperative", setup: () => ({ value: true,
    teardown: () => { cleaned = true; },
  }) });
  const execution = executeCase({ spec: spec(), fixtures: [fixture], run: (context) => {
    started.resolve();
    return new Promise<void>((resolve) => context.signal.addEventListener("abort", () => {
      assert.equal(context.acknowledgeCancellation(), true);
      resolve();
    }));
  },
  }, { platform: "web", timeoutMs: 10, cancellationGraceMs: 5, clock: time.clock });
  await started.promise;
  time.advance(10);
  const report = await execution;
  assert.equal(report.result.status, "timedOut");
  assert.equal(cleaned, true);
  assert.match(diagnostics(report), /"state":"cooperativeStopped"/);
  assert.match(diagnostics(report), /"status":"released"/);
  validReport(report);
});

test("cleanup failure is tainted, names its resource, and cannot replace the body cause", async () => {
  const report = await executeCase({ spec: spec(), run: async (context) => {
    context.registerResource({ id: "case.resource", ownership: "owned",
      cleanup: () => ({ status: "unconfirmed", reason: "release receipt missing" }) });
    throw new Error("body remains primary");
  } }, { platform: "web" });
  assert.equal(report.result.status, "failed");
  assert.equal(report.result.error?.message, "body remains primary");
  assert.match(diagnostics(report), /case\.resource/);
  assert.match(diagnostics(report), /cleanupUnconfirmed/);
  assert.match(diagnostics(report), /"tainted":true/);
  validReport(report);
});

test("cleanup-time resource registration stays a sticky failure when its error is swallowed", async () => {
  let lateAcquired = false;
  let lateCleaned = false;
  const report = await executeCase({ spec: spec(), run: async (context) => {
    context.registerResource({ id: "case.owner", ownership: "owned", cleanup: () => {
      lateAcquired = true;
      try {
        context.registerResource({ id: "case.leaked", ownership: "owned",
          cleanup: () => { lateCleaned = true; return { status: "released" }; } });
      } catch { /* A provider cannot swallow ResourceScope's sticky failure. */ }
      return { status: "released" };
    } });
    await context.criterion("verified", () => assert.ok(true));
  } }, { platform: "web" });
  assert.equal(lateAcquired, true);
  assert.equal(lateCleaned, false);
  assert.equal(report.result.status, "failed");
  assert.equal(report.result.error?.category, "fixtureTeardown");
  assert.match(diagnostics(report), /scopeClosed/);
  assert.match(diagnostics(report), /"tainted":true/);
  validReport(report);
});

test("a lifecycle deadline during cleanup publishes no stale release receipt", { timeout: 1000 }, async () => {
  const time = manualClock();
  const cleanupStarted = deferred<void>();
  const release = deferred<{ status: "released" }>();
  const execution = executeCase({ spec: spec(), run: async (context) => {
    context.registerResource({ id: "case.pending-cleanup", ownership: "owned", cleanup: () => {
      cleanupStarted.resolve();
      return release.promise;
    } });
    await context.criterion("verified", () => assert.ok(true));
  } }, { platform: "web", timeoutMs: 10, clock: time.clock });
  await cleanupStarted.promise;
  time.advance(10);
  const report = await execution;
  const before = JSON.stringify(report);
  assert.equal(report.result.status, "timedOut");
  assert.match(diagnostics(report), /producerUnconfirmed/);
  assert.doesNotMatch(diagnostics(report), /case\.pending-cleanup[^\n]*released/);
  release.resolve({ status: "released" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(report), before);
  validReport(report);
});

test("deadline during partial cleanup retains completed receipts and remaining resource ids",
  { timeout: 1000 }, async () => {
    const time = manualClock();
    const pendingStarted = deferred<void>();
    const pending = deferred<{ status: "released" }>();
    const execution = executeCase({ spec: spec(), run: async (context) => {
      context.registerResource({ id: "case.pending", ownership: "owned", cleanup: () => {
        pendingStarted.resolve(); return pending.promise;
      } });
      context.registerResource({ id: "case.completed", ownership: "owned",
        cleanup: () => ({ status: "released" }) });
      await context.criterion("verified", () => assert.ok(true));
    } }, { platform: "web", timeoutMs: 10, clock: time.clock });
    await pendingStarted.promise;
    time.advance(10);
    const report = await execution;
    const before = JSON.stringify(report);
    const text = diagnostics(report);
    assert.equal(report.result.status, "timedOut");
    assert.match(text, /"state":"unconfirmed"/);
    assert.match(text, /"tainted":true/);
    assert.match(text, /"id":"case\.completed","ownership":"owned","status":"released"/);
    assert.match(text, /"remaining":\[\{"id":"case\.pending","ownership":"owned"\}/);
    assert.equal(report.result.steps.find(({ id }) => id === "kernel.cleanup")?.status, "failed");
    pending.resolve({ status: "released" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(JSON.stringify(report), before);
    validReport(report);
  });
