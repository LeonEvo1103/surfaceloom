import assert from "node:assert/strict";
import test from "node:test";
import { defineFixture } from "@surfaceloom/core";
import { CaseRegistry, defineCase, executeCase } from "../src/index.js";
import { spec } from "./support.js";

test("definitions validate and freeze CaseSpec without rewriting its semantics", () => {
  const original = spec();
  const definition = defineCase({ spec: original, run: () => undefined });
  assert.deepEqual(definition.spec, original);
  assert.ok(Object.isFrozen(definition));
  assert.ok(Object.isFrozen(definition.spec.acceptanceCriteria));
  assert.ok(Object.isFrozen(definition.fixtures));
  assert.throws(() => defineCase({ spec: { ...original, name: "English only" },
    run: () => undefined }), /Chinese/);
});

test("registration is explicit, instance-local, stable, and rejects duplicate identities", () => {
  const first = defineCase({ spec: spec("case.first"), run: () => undefined });
  const second = defineCase({ spec: spec("case.second"), run: () => undefined });
  const registry = new CaseRegistry([first]);
  registry.register(second);
  assert.deepEqual(registry.list().map((item) => item.spec.id), ["case.first", "case.second"]);
  assert.equal(registry.require("case.second").run, second.run);
  assert.throws(() => registry.register(first), /already registered/);
  assert.throws(() => new CaseRegistry().require("case.first"), /No case/);
  assert.ok(Object.isFrozen(registry.list()));
});

test("invalid definitions and mismatched platform reject before resource setup", async () => {
  let setups = 0;
  const fixture = defineFixture({ id: "resource", setup: () => ({ value: ++setups }) });
  const definition = { spec: spec(), fixtures: [fixture], run: () => undefined };
  await assert.rejects(executeCase(definition, { platform: "macos" }), /does not support/);
  await assert.rejects(executeCase({ ...definition, fixtures: [fixture, fixture] },
    { platform: "web" }), /Duplicate case fixture/);
  await assert.rejects(executeCase({ ...definition, spec: { ...spec(), acceptanceCriteria: [] } },
    { platform: "web" }), /acceptance criterion/);
  assert.equal(setups, 0);
});
