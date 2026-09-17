import assert from "node:assert/strict";
import test from "node:test";
import type { EffectDescriptor } from "../src/effects.js";
import { ExecutionPolicyError } from "../src/plan-errors.js";
import type { ExecutionEffectPolicy } from "../src/policy-contracts.js";
import { preflightExecution } from "../src/policy.js";
import { effect, environment, errorCode, localPolicy, plan } from "./policy-support.js";

test("explicit local resource grants allow read, resettable write, and execution", async () => {
  const gate = preflightExecution(plan(), environment(), localPolicy());
  let calls = 0;
  for (const operation of ["read", "write", "execute"] as const) {
    const result = await gate.dispatch(effect({ operation, recovery: "resettable" }), (authorized) => {
      calls++;
      assert.equal(authorized.operation, operation);
      assert.ok(Object.isFrozen(authorized));
      return 42;
    });
    assert.equal(result, 42);
  }
  assert.equal(calls, 3);
});

test("Case and plan declarations cannot elevate the runner policy", async () => {
  const external = effect({ boundary: "external" });
  let calls = 0;
  await assert.rejects(async () => {
    const gate = preflightExecution(plan("externalEffect", [external]), environment(), localPolicy());
    await gate.dispatch(external, () => { calls++; });
  }, errorCode("effectLimitExceeded"));
  assert.equal(calls, 0);
  const readOnlyPolicy = { ...localPolicy(), maximumSideEffect: "readOnly" as const };
  assert.throws(() => preflightExecution(plan("writesLocal"), environment(), readOnlyPolicy), errorCode("effectLimitExceeded"));
});

test("default resource denial, wrong operation, and resource prefix mismatch fail before callback", async () => {
  const denied = [
    ["resourceDenied", {}, effect()],
    ["resourceDenied", localPolicy(), effect({ resource: "fixture.document.child" })],
    ["operationDenied", { grants: [{ resource: "fixture.document", operations: ["read"] }] }, effect({ operation: "write" })],
  ] as const;
  for (const [code, policy, actionEffect] of denied) {
    const gate = preflightExecution(plan(), environment(), policy);
    let calls = 0;
    await assert.rejects(gate.dispatch(actionEffect, () => { calls++; }), errorCode(code));
    assert.equal(calls, 0);
  }
});

test("external effects need both a sufficient ceiling and explicit external resource access", async () => {
  const external = effect({ boundary: "external", operation: "execute", recovery: "resettable" });
  const policy: ExecutionEffectPolicy = { ...localPolicy(), maximumSideEffect: "externalEffect" };
  const denied = preflightExecution(plan("externalEffect"), environment(), policy);
  let calls = 0;
  await assert.rejects(denied.dispatch(external, () => { calls++; }), errorCode("externalEffectDenied"));
  assert.equal(calls, 0);
  const explicit: ExecutionEffectPolicy = { maximumSideEffect: "externalEffect", grants: [{
    resource: "fixture.document", operations: ["execute"], boundaries: ["external"],
  }] };
  const approved = preflightExecution(plan("externalEffect", [external]), environment(), explicit);
  await approved.dispatch(external, () => { calls++; });
  assert.equal(calls, 1);
});

test("security-sensitive actions default to denied even under the highest coarse ceiling", async () => {
  const sensitive = effect({ securitySensitive: true });
  const policy: ExecutionEffectPolicy = { ...localPolicy(), maximumSideEffect: "securitySensitive" };
  const denied = preflightExecution(plan("securitySensitive"), environment(), policy);
  let calls = 0;
  await assert.rejects(denied.dispatch(sensitive, () => { calls++; }), errorCode("securitySensitiveDenied"));
  assert.equal(calls, 0);
  const allowed = preflightExecution(plan("securitySensitive", [sensitive]), environment(), {
    maximumSideEffect: "securitySensitive",
    grants: [{ resource: "fixture.document", operations: ["read"], allowSecuritySensitive: true }],
  });
  await allowed.dispatch(sensitive, () => { calls++; });
  assert.equal(calls, 1);
});

test("unknown recovery must be explicitly allowed, including for reads", async () => {
  for (const operation of ["read", "write"] as const) {
    const unknown = effect({ operation, recovery: "unknown" });
    const denied = preflightExecution(plan(), environment(), localPolicy());
    let calls = 0;
    await assert.rejects(denied.dispatch(unknown, () => { calls++; }), errorCode("unknownRecoveryDenied"));
    assert.equal(calls, 0);
    const allowed = preflightExecution(plan("writesLocal", [unknown]), environment(), {
      grants: [{ resource: "fixture.document", operations: [operation], allowUnknownRecovery: true }],
    });
    await allowed.dispatch(unknown, () => { calls++; });
    assert.equal(calls, 1);
  }
});

test("external and security-sensitive permissions are independent", async () => {
  const both = effect({ boundary: "external", securitySensitive: true });
  let calls = 0;
  for (const [code, grant] of [
    ["externalEffectDenied", { resource: "fixture.document", operations: ["read"], allowSecuritySensitive: true }],
    ["securitySensitiveDenied", { resource: "fixture.document", operations: ["read"], boundaries: ["external"] }],
  ] as const) {
    const gate = preflightExecution(plan("securitySensitive"), environment(), {
      maximumSideEffect: "securitySensitive", grants: [grant],
    });
    await assert.rejects(gate.dispatch(both, () => { calls++; }), errorCode(code));
  }
  assert.equal(calls, 0);
});

test("precise declarations restrict operations, resource, and recovery without broadening grants", async () => {
  const gate = preflightExecution(plan("writesLocal", [effect()]), environment(), localPolicy());
  let calls = 0;
  for (const changed of [effect({ operation: "write" }), effect({ recovery: "resettable" }),
    effect({ resource: "fixture.other" })]) {
    await assert.rejects(gate.dispatch(changed, () => { calls++; }), errorCode("undeclaredEffect"));
  }
  assert.equal(calls, 0);
  const none = preflightExecution(plan("readOnly", []), environment(), localPolicy());
  await assert.rejects(none.dispatch(effect(), () => { calls++; }), errorCode("undeclaredEffect"));
  assert.equal(calls, 0);
});

test("legacy declaration still needs a precise action descriptor and cannot exceed the Case ceiling", async () => {
  const gate = preflightExecution(plan("readOnly"), environment(), localPolicy());
  let calls = 0;
  await assert.rejects(gate.dispatch("readOnly" as unknown as EffectDescriptor, () => { calls++; }), errorCode("invalidInput"));
  await assert.rejects(gate.dispatch(effect({ operation: "write" }), () => { calls++; }), errorCode("incompatibleEffectSummary"));
  assert.equal(calls, 0);
  await gate.dispatch(effect(), () => { calls++; });
  assert.equal(calls, 1);
});

test("precise effects are checked during preflight before setup can begin", () => {
  assert.throws(() => preflightExecution(plan("writesLocal", [effect()]), environment()), errorCode("resourceDenied"));
  assert.throws(() => preflightExecution(plan("writesLocal", [effect({ recovery: "unknown" })]), environment(), localPolicy()), errorCode("unknownRecoveryDenied"));
});

test("grants are snapshotted; modifying caller config cannot widen an existing gate", async () => {
  const operations: ("read" | "write")[] = ["read"];
  const grant = { resource: "fixture.document", operations, allowUnknownRecovery: false };
  const policy = { grants: [grant] };
  const gate = preflightExecution(plan(), environment(), policy);
  operations.push("write");
  grant.allowUnknownRecovery = true;
  policy.grants.push({ resource: "other", operations: ["read"], allowUnknownRecovery: true });
  let calls = 0;
  await assert.rejects(gate.dispatch(effect({ operation: "write" }), () => { calls++; }), errorCode("operationDenied"));
  await assert.rejects(gate.dispatch(effect({ recovery: "unknown" }), () => { calls++; }), errorCode("unknownRecoveryDenied"));
  await assert.rejects(gate.dispatch(effect({ resource: "other" }), () => { calls++; }), errorCode("resourceDenied"));
  assert.equal(calls, 0);
});

test("dispatch never replays a callback that throws or rejects", async () => {
  const gate = preflightExecution(plan(), environment(), localPolicy());
  const original = new Error("action outcome unknown");
  let calls = 0;
  await assert.rejects(gate.dispatch(effect(), () => { calls++; throw original; }), (error) => error === original);
  assert.equal(calls, 1);
  await assert.rejects(gate.dispatch(effect(), async () => { calls++; throw original; }), (error) => error === original);
  assert.equal(calls, 2);
});

test("policy input is validated and rejection errors expose stable immutable diagnostics", () => {
  for (const malformed of [null, { grants: null }, { maximumSideEffect: "all" }, { allowEverything: true },
    { grants: [{ resource: "*", operations: ["read"] }] }, { grants: [{ resource: "fixture.document", operations: [] }] },
    { grants: [localPolicy().grants![0], localPolicy().grants![0]] },
    { grants: [{ resource: "fixture.document", operations: ["read"], allowUnknownRecovery: "true" }] }]) {
    assert.throws(() => preflightExecution(plan(), environment(), malformed as ExecutionEffectPolicy), errorCode("invalidInput"));
  }
  try { preflightExecution(plan(), { ...environment(), surfaces: {} }); assert.fail("expected error"); }
  catch (error) {
    assert.ok(error instanceof ExecutionPolicyError);
    assert.equal(error.code, "missingSurface");
    assert.equal(error.phase, "preflight");
    assert.deepEqual(error.details, { surface: "ui" });
    assert.ok(Object.isFrozen(error.details));
  }
});

test("malformed action descriptors are attributed to authorization before callback dispatch", async () => {
  const gate = preflightExecution(plan("writesLocal"), environment(), localPolicy());
  let callbacks = 0;
  await assert.rejects(gate.dispatch(null as never, () => { callbacks += 1; }), (error: unknown) => {
    assert.ok(error instanceof ExecutionPolicyError);
    assert.equal(error.code, "invalidInput");
    assert.equal(error.phase, "authorize");
    return true;
  });
  assert.equal(callbacks, 0);
});
