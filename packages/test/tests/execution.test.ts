import assert from "node:assert/strict";
import test from "node:test";
import { defineFixture } from "@surfaceloom/core";
import { defineCase, executeCase } from "../src/index.js";
import { diagnostics, spec, validReport } from "./support.js";

test("success sets up dependencies, records steps/criteria, and closes test before worker", async () => {
  const events: string[] = [];
  const host = defineFixture({
    id: "host", scope: "worker",
    setup: () => {
      events.push("host.setup");
      return { value: 20, teardown: () => { events.push("host.teardown"); } };
    },
  });
  const session = defineFixture({
    id: "session", dependencies: [host],
    setup: (context) => {
      events.push("session.setup");
      return { value: context.get(host) + 1,
        teardown: () => { events.push("session.teardown"); } };
    },
  });
  const report = await executeCase(defineCase({
    spec: { ...spec(), acceptanceCriteria: [
      { id: "verified", text: "观察结果符合预期。" },
      { id: "value-returned", text: "步骤返回计算结果。" },
    ] },
    fixtures: [session],
    run: async (context) => {
      events.push("body");
      const value = await context.step({ id: "compute", title: "计算结果",
        criterionIds: ["value-returned"] }, () => context.fixture(session) * 2);
      await context.criterion("verified", () => assert.equal(value, 42));
    },
  }), { platform: "web" });
  assert.equal(report.result.status, "passed");
  assert.equal(report.result.error, undefined);
  assert.deepEqual(events, ["host.setup", "session.setup", "body", "session.teardown", "host.teardown"]);
  assert.deepEqual(report.result.steps.flatMap((step) => step.criterionIds ?? []), ["value-returned", "verified"]);
  assert.ok(Object.isFrozen(report.result.steps));
  for (const step of report.result.steps) {
    assert.ok(Object.isFrozen(step));
    if (step.criterionIds !== undefined) assert.ok(Object.isFrozen(step.criterionIds));
  }
  validReport(report);
});

test("body failure becomes a legal result and still cleans up", async () => {
  let cleaned = false;
  const fixture = defineFixture({ id: "resource", setup: () => ({
    value: true, teardown: () => { cleaned = true; },
  }) });
  const report = await executeCase({ spec: spec(), fixtures: [fixture],
    run: () => { throw new Error("body failed first"); } }, { platform: "web" });
  assert.equal(report.result.status, "failed");
  assert.deepEqual(report.result.error, { category: "body", message: "body failed first" });
  assert.equal(cleaned, true);
  validReport(report);
});

test("setup failure skips the body and rolls back dependencies plus earlier resources", async () => {
  const events: string[] = [];
  const stable = defineFixture({ id: "stable", setup: () => ({
    value: true, teardown: () => { events.push("stable.teardown"); },
  }) });
  const dependency = defineFixture({ id: "dependency", setup: () => ({
    value: true, teardown: () => { events.push("dependency.teardown"); },
  }) });
  const failing = defineFixture({ id: "failing", dependencies: [dependency],
    setup: () => { throw new Error("setup failed"); } });
  const report = await executeCase({ spec: spec(), fixtures: [stable, failing],
    run: () => { events.push("body"); } }, { platform: "web" });
  assert.equal(report.result.status, "failed");
  assert.deepEqual(report.result.error, { category: "fixtureSetup", message: "setup failed" });
  assert.deepEqual(events, ["dependency.teardown", "stable.teardown"]);
  validReport(report);
});

test("teardown failure prevents green and does not stop remaining teardown", async () => {
  const events: string[] = [];
  const first = defineFixture({ id: "first", setup: () => ({ value: true,
    teardown: () => { events.push("first"); throw new Error("first cleanup failed"); },
  }) });
  const second = defineFixture({ id: "second", setup: () => ({ value: true,
    teardown: () => { events.push("second"); throw new Error("second cleanup failed"); },
  }) });
  const report = await executeCase({ spec: spec(), fixtures: [first, second],
    run: async (context) => { await context.criterion("verified", () => assert.ok(true)); },
  }, { platform: "web" });
  assert.equal(report.result.status, "failed");
  assert.deepEqual(report.result.error, { category: "fixtureTeardown", message: "second cleanup failed" });
  assert.deepEqual(events, ["second", "first"]);
  assert.match(diagnostics(report), /second cleanup failed/);
  assert.match(diagnostics(report), /first cleanup failed/);
  validReport(report);
});

test("body stays the first cause when both test and worker teardown fail", async () => {
  const worker = defineFixture({ id: "worker", scope: "worker", setup: () => ({ value: true,
    teardown: () => { throw new Error("worker cleanup failed"); },
  }) });
  const scoped = defineFixture({ id: "scoped", dependencies: [worker], setup: () => ({ value: true,
    teardown: () => { throw new Error("test cleanup failed"); },
  }) });
  const report = await executeCase({ spec: spec(), fixtures: [scoped],
    run: () => { throw new Error("original body failure"); } }, { platform: "web" });
  assert.equal(report.result.error?.message, "original body failure");
  assert.match(diagnostics(report), /test cleanup failed/);
  assert.match(diagnostics(report), /worker cleanup failed/);
  assert.equal(report.result.steps.filter((step) => step.status === "failed").length, 3);
  validReport(report);
});

test("setup error remains first when Core aggregates setup and rollback failures", async () => {
  const dependency = defineFixture({ id: "dependency", setup: () => ({ value: true,
    teardown: () => { throw new Error("rollback failed"); },
  }) });
  const failing = defineFixture({ id: "failing", dependencies: [dependency],
    setup: () => { throw new Error("original setup failure"); } });
  const report = await executeCase({ spec: spec(), fixtures: [failing],
    run: () => { assert.fail("body must not run"); } }, { platform: "web" });
  assert.equal(report.result.error?.message, "original setup failure");
  assert.match(diagnostics(report), /rollback failed/);
  validReport(report);
});

test("ordinary cases need no fixtures and worker resources are isolated per execution", async () => {
  const ordinary = await executeCase({ spec: spec(), run: async (context) => {
    await context.criterion("verified", () => assert.equal(2 + 2, 4));
  } }, { platform: "web" });
  assert.equal(ordinary.result.status, "passed");
  validReport(ordinary);
  let setups = 0;
  let closes = 0;
  const worker = defineFixture({ id: "worker", scope: "worker", setup: () => ({
    value: ++setups, teardown: () => { closes += 1; },
  }) });
  const definition = defineCase({ spec: spec(), fixtures: [worker], run: async (context) => {
    await context.criterion("verified", () => assert.equal(context.fixture(worker), setups));
  } });
  await executeCase(definition, { platform: "web" });
  await executeCase(definition, { platform: "web" });
  assert.equal(setups, 2);
  assert.equal(closes, 2);
});
