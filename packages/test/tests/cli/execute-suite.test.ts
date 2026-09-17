import assert from "node:assert/strict";
import test from "node:test";
import { executeCaseSuite } from "../../src/cli/index.js";
import { defineExecutionPlan } from "../../src/plan.js";
import { spec } from "../support.js";

const run = {
  id: "suite.execute",
  title: "Execute suite",
  app: { id: "fixture.app", name: "Fixture App" },
};

test("suite executes selected Cases sequentially through the kernel and continues after failure", async () => {
  const events: string[] = [];
  const result = await executeCaseSuite([{
    spec: spec("case.first"),
    run: async (context) => {
      events.push("first");
      await context.criterion("verified", () => { throw new Error("expected failure"); });
    },
  }, {
    spec: spec("case.second"),
    run: async (context) => {
      events.push("second");
      await context.criterion("verified", () => assert.ok(true));
    },
  }], { platform: "web", run });
  assert.deepEqual(events, ["first", "second"]);
  assert.deepEqual(result.report.input.tests.map((item) => item.result.status), ["failed", "passed"]);
  assert.equal(result.report.summary.failed, 1);
  assert.equal(result.report.exitCode, 1);
});

test("suite selection is stable and excludes cases for other report platforms", async () => {
  const result = await executeCaseSuite([{
    spec: spec("case.browser"), run: async (context) => {
      await context.criterion("verified", () => assert.ok(true));
    },
  }, {
    spec: { ...spec("case.native"), platforms: ["macos"] }, run: () => assert.fail("must not run"),
  }], {
    platform: "web", run,
  });
  assert.deepEqual(result.selected.map((item) => item.definition.spec.id), ["case.browser"]);
  assert.equal(result.report.input.tests[0]?.result.status, "passed");
  await assert.rejects(executeCaseSuite([{
    spec: { ...spec("case.native"), platforms: ["macos"] }, run: () => undefined,
  }], {
    platform: "web", run, selection: { ids: ["case.native"] },
  }), /do not support platform web/);
});

test("preflight rejection becomes a per-Case failure and later Cases still run", async () => {
  let laterRan = false;
  const result = await executeCaseSuite([{
    definition: { spec: spec("case.bad-plan"), run: () => assert.fail("must not run") },
    options: { environment: { platform: "macos", host: { os: "macos" }, surfaces: {} } },
  }, {
    spec: spec("case.after"), run: async (context) => {
      laterRan = true;
      await context.criterion("verified", () => assert.ok(true));
    },
  }], { platform: "web", run });
  assert.equal(laterRan, true);
  assert.equal(result.report.input.tests[0]?.result.status, "failed");
  assert.equal(result.report.input.tests[0]?.result.error?.category, "runner");
  assert.equal(result.report.input.tests[1]?.result.status, "passed");
});

test("capability and policy gates become honest unsupported and skipped results", async () => {
  const capabilityCase = { spec: spec("case.capability"), run: () => assert.fail("must not run") };
  const policyCase = { spec: { ...spec("case.policy"), sideEffect: "writesLocal" as const },
    run: () => assert.fail("must not run") };
  const result = await executeCaseSuite([{
    definition: capabilityCase,
    options: {
      plan: defineExecutionPlan({ spec: capabilityCase.spec, requirements: {
        surfaces: { page: { kind: "browser", capabilities: ["browser.dom.inspect"] } },
      } }),
      environment: { platform: "web", host: { os: "linux" }, surfaces: {} },
    },
  }, {
    definition: policyCase,
    options: {
      plan: defineExecutionPlan({ spec: policyCase.spec, requirements: { surfaces: {} } }),
      policy: { maximumSideEffect: "readOnly" },
    },
  }], { platform: "web", run });
  assert.deepEqual(result.report.input.tests.map((item) => item.result.status), ["unsupported", "skipped"]);
  assert.match(result.report.input.tests[0]?.result.reason ?? "", /missingSurface/);
  assert.match(result.report.input.tests[1]?.result.reason ?? "", /effectLimitExceeded/);
  assert.equal(result.report.status, "incomplete");
  assert.equal(result.report.exitCode, 1);
});

test("unknown exact ids fail before executing any Case", async () => {
  let ran = false;
  await assert.rejects(executeCaseSuite([{
    spec: spec("case.known"), run: () => { ran = true; },
  }], { platform: "web", run, selection: { ids: ["case.missing"] } }), /Unknown Case ids/);
  assert.equal(ran, false);
});

test("a text filter cannot silently hide an incompatible matching Case", async () => {
  let ran = false;
  await assert.rejects(executeCaseSuite([{
    spec: { ...spec("case.web-match"), name: "共享筛选目标" },
    run: () => { ran = true; },
  }, {
    spec: { ...spec("case.native-match"), name: "共享筛选目标", platforms: ["macos"] },
    run: () => assert.fail("must not run"),
  }], {
    platform: "web", run, selection: { filters: ["共享筛选"] },
  }), /do not support platform web/);
  assert.equal(ran, false);
});
