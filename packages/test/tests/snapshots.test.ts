import assert from "node:assert/strict";
import test from "node:test";
import type { FixtureContext, FixtureScope, TestPlatform } from "@surfaceloom/core";
import { CaseRegistry, defineCase, executeCase } from "../src/index.js";
import { spec, validReport } from "./support.js";

test("registration snapshots mutable fixture graphs while preserving provider and body identities", async () => {
  const events: string[] = [];
  const dependency = {
    id: "dependency", scope: "worker" as FixtureScope,
    setup: () => {
      events.push("dependency.setup");
      return { value: 21, teardown: () => { events.push("dependency.teardown"); } };
    },
  };
  const resource = {
    id: "resource", dependencies: [dependency],
    setup: (context: FixtureContext) => {
      events.push("resource.setup");
      return { value: context.get(dependency) * 2,
        teardown: () => { events.push("resource.teardown"); } };
    },
  };
  const registry = new CaseRegistry([{ spec: spec(), fixtures: [resource, dependency],
    run: async (context) => {
      await context.criterion("verified", () => {
        assert.equal(context.fixture(resource), 42);
        assert.equal(context.fixture(dependency), 21);
        assert.equal(context.fixture(registry.require("kernel.case").fixtures![0]!), 42);
      });
    },
  }]);
  dependency.id = "mutated-dependency";
  dependency.scope = "test";
  dependency.setup = () => { throw new Error("mutated dependency setup ran"); };
  resource.setup = () => { throw new Error("mutated resource setup ran"); };
  resource.dependencies.length = 0;
  const registered = registry.require("kernel.case");
  assert.ok(Object.isFrozen(registered.fixtures![0]));
  assert.ok(Object.isFrozen(registered.fixtures![0]!.dependencies));
  assert.equal(registered.fixtures![1]!.id, "dependency");
  const report = await executeCase(registered, { platform: "web" });
  assert.equal(report.result.status, "passed");
  assert.deepEqual(events, ["dependency.setup", "resource.setup", "resource.teardown", "dependency.teardown"]);
  validReport(report);
});

test("redefining a copied case retains original fixture identity for setup and body reads", async () => {
  const dependency = { id: "dependency", setup: () => ({ value: 21 }) };
  const fixture = { id: "fixture", dependencies: [dependency],
    setup: (context: FixtureContext) => ({ value: context.get(dependency) * 2 }) };
  const definition = defineCase({ spec: spec(), fixtures: [fixture], run: async (context) => {
    await context.criterion("verified", () => assert.equal(context.fixture(fixture), 42));
  } });
  const report = await executeCase({ ...definition }, { platform: "web" });
  assert.equal(report.result.status, "passed");
  validReport(report);
});

test("executeCase snapshots platform before execution can mutate its options", async () => {
  let platform: TestPlatform = "web";
  let reads = 0;
  const options = { get platform(): TestPlatform { reads += 1; return platform; } };
  const report = await executeCase({ spec: spec(), run: async (context) => {
    platform = "macos";
    await context.criterion("verified", () => assert.ok(true));
  } }, options);
  assert.equal(report.result.status, "passed");
  assert.equal(reads, 1);
  validReport(report);
});
