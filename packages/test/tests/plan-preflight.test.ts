import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionEnvironment, ExecutionPlan, ExecutionRequirements } from "../src/plan-contracts.js";
import { defineExecutionPlan } from "../src/plan.js";
import { preflightExecution } from "../src/policy.js";
import { effect, environment, errorCode, localPolicy, plan, requirements } from "./policy-support.js";
import { spec } from "./support.js";

test("browser execution keeps host OS distinct from the legacy web platform", () => {
  const candidate = defineExecutionPlan({ spec: spec(), requirements: { ...requirements(), host: { os: ["linux"] } } });
  assert.doesNotThrow(() => preflightExecution(candidate, environment(), localPolicy()));
});

test("unavailable host, surface, kind, or capability prevents callback dispatch", async () => {
  const cases = [
    ["hostUnsupported", { ...environment(), platform: "macos", host: { os: "linux" } },
      { ...plan(), spec: { ...spec(), platforms: ["macos"] } }],
    ["missingSurface", { ...environment(), surfaces: {} }, plan()],
    ["surfaceKindMismatch", { ...environment(), surfaces: { ui: { kind: "desktop", capabilities: [] } } }, plan()],
    ["missingCapability", { ...environment(), surfaces: { ui: { kind: "browser", capabilities: [] } } }, plan()],
  ] as const;
  for (const [code, available, source] of cases) {
    const candidate = defineExecutionPlan({ spec: source.spec, requirements: source.requirements });
    let calls = 0;
    await assert.rejects(async () => {
      const gate = preflightExecution(candidate, available as ExecutionEnvironment, localPolicy());
      await gate.dispatch(effect(), () => { calls++; });
    }, errorCode(code));
    assert.equal(calls, 0);
  }
});

test("explicit host restriction and CaseSpec platform restrictions are enforced", () => {
  const restricted = defineExecutionPlan({ spec: spec(), requirements: { ...requirements(), host: { os: ["windows"] } } });
  assert.throws(() => preflightExecution(restricted, environment(), localPolicy()), errorCode("hostUnsupported"));
  const mac = defineExecutionPlan({ spec: { ...spec(), platforms: ["macos"] }, requirements: requirements() });
  assert.throws(() => preflightExecution(mac, environment(), localPolicy()), errorCode("casePlatformUnsupported"));
});

test("a capability on another surface does not satisfy the requested surface", () => {
  const available: ExecutionEnvironment = { ...environment(), surfaces: {
    ui: { kind: "browser", capabilities: [] }, other: environment().surfaces.ui!,
  } };
  assert.throws(() => preflightExecution(plan(), available, localPolicy()), errorCode("missingCapability"));
});

test("preflight rejects undeclared capabilities, malformed inputs, and forged plans", () => {
  const invalidRequirements = [null, { surfaces: [] }, { surfaces: {}, host: { os: [] } },
    { surfaces: {}, host: { os: ["darwin"] } }, { surfaces: {}, hook: "bypass" },
    { surfaces: { ui: { kind: "agent", capabilities: [] } } },
    { surfaces: { ui: { kind: "browser", capabilities: ["do.anything"] } } },
    { surfaces: { ui: { kind: "browser", capabilities: ["ui.inspect", "ui.inspect"] } } }];
  for (const value of invalidRequirements) {
    assert.throws(() => defineExecutionPlan({ spec: spec(), requirements: value as ExecutionRequirements }), errorCode("invalidInput"));
  }
  assert.throws(() => preflightExecution({ ...plan() } as ExecutionPlan, environment()), errorCode("invalidInput"));
  assert.throws(() => preflightExecution(plan(), { ...environment(), host: { os: "web" } } as unknown as ExecutionEnvironment), errorCode("invalidInput"));
});

test("plain prototype-key surface names are handled as exact own keys", () => {
  const required: ExecutionRequirements = { surfaces: { constructor: { kind: "browser", capabilities: [] } } };
  const candidate = defineExecutionPlan({ spec: spec(), requirements: required });
  assert.throws(() => preflightExecution(candidate, environment()), errorCode("missingSurface"));
});
