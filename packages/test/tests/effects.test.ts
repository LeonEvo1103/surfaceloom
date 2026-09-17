import assert from "node:assert/strict";
import test from "node:test";
import { defineEffect, effectSideEffectLevel, type EffectDescriptor } from "../src/effects.js";
import { defineExecutionPlan } from "../src/plan.js";
import { effect, errorCode, plan, requirements } from "./policy-support.js";
import { spec } from "./support.js";

test("precise effects map conservatively to the existing coarse side-effect order", () => {
  assert.equal(effectSideEffectLevel(effect()), "readOnly");
  assert.equal(effectSideEffectLevel(effect({ operation: "write", recovery: "resettable" })), "reversible");
  assert.equal(effectSideEffectLevel(effect({ operation: "execute", recovery: "resettable" })), "reversible");
  assert.equal(effectSideEffectLevel(effect({ operation: "write" })), "writesLocal");
  assert.equal(effectSideEffectLevel(effect({ operation: "execute", recovery: "unknown" })), "writesLocal");
  assert.equal(effectSideEffectLevel(effect({ boundary: "external" })), "externalEffect");
  assert.equal(effectSideEffectLevel(effect({ securitySensitive: true })), "securitySensitive");
  assert.equal(effectSideEffectLevel(effect({ boundary: "external", securitySensitive: true })), "securitySensitive");
});

test("a precise effect may not exceed the CaseSpec summary", () => {
  assert.throws(() => plan("readOnly", [effect({ operation: "write" })]), errorCode("incompatibleEffectSummary"));
  assert.throws(() => plan("reversible", [effect({ operation: "write", recovery: "unknown" })]), errorCode("incompatibleEffectSummary"));
  assert.throws(() => plan("writesLocal", [effect({ boundary: "external" })]), errorCode("incompatibleEffectSummary"));
  assert.throws(() => plan("externalEffect", [effect({ securitySensitive: true })]), errorCode("incompatibleEffectSummary"));
});

test("legacy plans preserve only the coarse declaration, never fabricated resources or recovery", () => {
  for (const maximum of ["readOnly", "reversible", "writesLocal", "externalEffect", "securitySensitive"] as const) {
    assert.deepEqual(plan(maximum).effectDeclaration, { kind: "legacy", maximum });
  }
  assert.deepEqual(plan("readOnly", []).effectDeclaration, { kind: "precise", effects: [] });
});

test("effect and plan snapshots are deeply frozen and isolated from caller mutation", () => {
  const input = effect();
  const declared = [input];
  const requested = { surfaces: { ui: { kind: "browser" as const, capabilities: ["browser.dom.inspect" as const] } } };
  const originalSpec = spec();
  const result = defineExecutionPlan({ spec: originalSpec, requirements: requested, effects: declared });
  (input as { resource: string }).resource = "another.resource";
  declared.length = 0;
  requested.surfaces.ui.capabilities.length = 0;
  (originalSpec as { sideEffect: string }).sideEffect = "securitySensitive";
  assert.equal(result.spec.sideEffect, "readOnly");
  assert.deepEqual(result.requirements.surfaces.ui?.capabilities, ["browser.dom.inspect"]);
  assert.equal(result.effectDeclaration.kind, "precise");
  if (result.effectDeclaration.kind === "precise") {
    assert.equal(result.effectDeclaration.effects[0]?.resource, "fixture.document");
    assert.ok(Object.isFrozen(result.effectDeclaration.effects[0]));
    assert.ok(Object.isFrozen(result.effectDeclaration.effects));
  }
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.requirements.surfaces.ui));
});

test("malformed, wildcard, duplicate, and accessor declarations are rejected", () => {
  const invalid = [null, [], { ...effect(), operation: "send" }, { ...effect(), recovery: "safe" },
    { ...effect(), resource: "*" }, { ...effect(), securitySensitive: "false" },
    { ...effect(), allowExternal: true }, { ...effect(), recovery: undefined }];
  for (const value of invalid) assert.throws(() => defineEffect(value as EffectDescriptor), errorCode("invalidInput"));
  assert.throws(() => plan("writesLocal", [effect(), effect()]), errorCode("invalidInput"));
  let reads = 0;
  const getter = { ...effect(), get resource() { reads++; return "fixture.document"; } };
  assert.throws(() => defineEffect(getter), errorCode("invalidInput"));
  assert.equal(reads, 0);
  const specGetter = { ...spec(), get sideEffect() { reads++; return "readOnly" as const; } };
  assert.throws(() => defineExecutionPlan({ spec: specGetter, requirements: requirements() }), errorCode("invalidInput"));
  assert.equal(reads, 0);
  assert.throws(() => defineExecutionPlan({ spec: spec(), requirements: requirements(), effects: [effect(), ,] as EffectDescriptor[] }), errorCode("invalidInput"));
});
