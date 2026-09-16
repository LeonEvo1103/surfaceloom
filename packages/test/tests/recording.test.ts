import assert from "node:assert/strict";
import test from "node:test";
import { defineFixture } from "@surfaceloom/core";
import { executeCase, type CaseContext } from "../src/index.js";
import { diagnostics, spec, validReport } from "./support.js";

test("returning without criterion coverage fails instead of reporting an empty success", async () => {
  const report = await executeCase({ spec: spec(), run: async (context) => {
    await context.step({ id: "action", title: "只执行动作" }, () => undefined);
  } }, { platform: "web" });
  assert.equal(report.result.status, "failed");
  assert.equal(report.result.error?.category, "acceptanceCriteria");
  assert.match(report.result.error?.message ?? "", /verified/);
  validReport(report);
});

test("a caught step failure remains failed after a subsequent passing criterion", async () => {
  const report = await executeCase({ spec: spec(), run: async (context) => {
    await assert.rejects(context.step({ id: "failure", title: "失败步骤" }, () => {
      throw new Error("step failure");
    }), /step failure/);
    await context.criterion("verified", () => assert.ok(true));
  } }, { platform: "web" });
  assert.equal(report.result.status, "failed");
  assert.equal(report.result.error?.message, "step failure");
  assert.equal(report.result.steps.find((step) => step.id === "failure")?.status, "failed");
  validReport(report);
});

test("registered, unawaited steps settle before teardown and retain rejection", async () => {
  const events: string[] = [];
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const stepStarted = new Promise<void>((resolve) => { started = resolve; });
  const fixture = defineFixture({ id: "resource", setup: () => ({ value: true,
    teardown: () => { events.push("teardown"); },
  }) });
  const execution = executeCase({ spec: spec(), fixtures: [fixture], run: (context) => {
    void context.step({ id: "pending", title: "等待步骤完成", criterionIds: ["verified"] }, async () => {
      started?.();
      await new Promise<void>((resolve) => { release = resolve; });
      events.push("step");
      throw new Error("pending failure");
    });
    throw new Error("earlier body failure");
  } }, { platform: "web" });
  await stepStarted;
  assert.deepEqual(events, []);
  release?.();
  const report = await execution;
  assert.deepEqual(events, ["step", "teardown"]);
  assert.equal(report.result.error?.message, "earlier body failure");
  assert.match(diagnostics(report), /pending failure/);
  validReport(report);
});

test("nested steps keep invocation order and coverage", async () => {
  const report = await executeCase({ spec: spec(), run: async (context) => {
    await context.step({ id: "outer", title: "外层步骤" }, async () => {
      await context.step({ id: "inner", title: "检查结果", criterionIds: ["verified"] },
        () => assert.ok(true));
    });
  } }, { platform: "web" });
  assert.equal(report.result.status, "passed");
  assert.deepEqual(report.result.steps.slice(0, 2).map((step) => step.id), ["outer", "inner"]);
  validReport(report);
});

test("invalid step metadata is retained as failure without dispatching its callback", async () => {
  const report = await executeCase({ spec: spec(), run: async (context) => {
    await context.step({ id: "unique", title: "第一次" }, () => undefined);
    for (const step of [
      { id: "unique", title: "重复步骤" },
      { id: "unknown", title: "未知条件", criterionIds: ["missing"] },
      { id: "kernel.reserved", title: "保留前缀" },
    ]) {
      await assert.rejects(context.step(step, () => assert.fail("invalid callback ran")));
    }
    await assert.rejects(context.criterion("missing", () => assert.fail("unknown criterion ran")));
    await context.criterion("verified", () => assert.ok(true));
  } }, { platform: "web" });
  assert.equal(report.result.status, "failed");
  assert.equal(report.result.error?.category, "authoring");
  assert.match(diagnostics(report), /Duplicate step id/);
  assert.equal(report.result.steps.filter((step) => step.status === "failed").length, 4);
  validReport(report);
});

test("a retained context cannot change a completed result or access closed fixtures", async () => {
  let retained: CaseContext | undefined;
  const fixture = defineFixture({ id: "value", setup: () => ({ value: 42 }) });
  const report = await executeCase({ spec: spec(), fixtures: [fixture], run: async (context) => {
    retained = context;
    await context.criterion("verified", () => assert.equal(context.fixture(fixture), 42));
  } }, { platform: "web" });
  const before = JSON.stringify(report);
  assert.throws(() => retained?.fixture(fixture), /no longer accepting work/);
  assert.throws(() => retained?.step({ id: "late", title: "迟到步骤" }, () => undefined), /no longer/);
  assert.throws(() => retained?.criterion("verified", () => undefined), /no longer/);
  assert.equal(JSON.stringify(report), before);
  validReport(report);
});

test("non-Error throws and empty Error messages still produce valid failures", async () => {
  for (const thrown of [undefined, "plain thrown value", new Error("")]) {
    const report = await executeCase({ spec: spec(), run: () => { throw thrown; } }, { platform: "web" });
    assert.equal(report.result.status, "failed");
    assert.ok(report.result.error?.message);
    validReport(report);
  }
});
