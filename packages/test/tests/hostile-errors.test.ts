import assert from "node:assert/strict";
import test from "node:test";
import { defineFixture } from "@surfaceloom/core";
import { executeCase } from "../src/index.js";
import { diagnostics, spec, validReport } from "./support.js";

const brokenGetter = { get: () => { throw new Error("introspection failed"); } };
const hostileValues: readonly [string, () => unknown][] = [
  ["message and name getters throw", () => Object.defineProperties(new Error(), {
    message: brokenGetter, name: brokenGetter,
  })],
  ["message and name are not strings", () => Object.defineProperties(new Error(), {
    message: { value: 42 }, name: { value: null },
  })],
  ["AggregateError errors getter throws", () => Object.defineProperties(new AggregateError([]), {
    message: brokenGetter, name: brokenGetter, errors: brokenGetter,
  })],
  ["AggregateError errors is not an array", () => Object.defineProperty(new AggregateError([]),
    "errors", { value: null })],
  ["AggregateError is circular", () => {
    const error = new AggregateError([]);
    error.errors.push(error);
    return error;
  }],
  ["Proxy rejects instanceof introspection", () => new Proxy(new Error(), {
    getPrototypeOf: () => { throw new Error("prototype introspection failed"); },
  })],
  ["AggregateError array length getter throws", () => Object.defineProperty(new AggregateError([]),
    "errors", { value: new Proxy([], { get: () => { throw new Error("array introspection failed"); } }) })],
  ["AggregateError array element getter throws", () => {
    const causes: unknown[] = [undefined, new Error("readable later cause")];
    Object.defineProperty(causes, "0", brokenGetter);
    return Object.defineProperty(new AggregateError([]), "errors", { value: causes });
  }],
];

for (const phase of ["body", "fixtureSetup", "fixtureTeardown"] as const) {
  test(`hostile error introspection during ${phase} still yields a failed report and full cleanup`, async () => {
    for (const [label, createError] of hostileValues) {
      const error = createError();
      const cleaned: string[] = [];
      const worker = defineFixture({ id: "worker", scope: "worker", setup: () => ({ value: true,
        teardown: () => { cleaned.push("worker"); },
      }) });
      const resource = defineFixture({ id: "resource", dependencies: [worker], setup: () => ({ value: true,
        teardown: () => {
          cleaned.push("test");
          if (phase === "fixtureTeardown") throw error;
        },
      }) });
      const setup = defineFixture({ id: "setup", setup: () => {
        if (phase === "fixtureSetup") throw error;
        return { value: true };
      } });
      const report = await executeCase({ spec: spec(), fixtures: [resource, setup],
        run: async (context) => {
          if (phase === "body") throw error;
          await context.criterion("verified", () => assert.ok(true));
        },
      }, { platform: "web" });
      assert.equal(report.result.status, "failed", label);
      assert.equal(report.result.error?.category, phase, label);
      assert.ok(report.result.error?.message, label);
      assert.deepEqual(cleaned, ["test", "worker"], label);
      validReport(report);
    }
  });
}

test("hostile teardown diagnostics retain an earlier body cause and remaining teardown", async () => {
  const cleaned: string[] = [];
  const first = defineFixture({ id: "first", setup: () => ({ value: true,
    teardown: () => { cleaned.push("first"); },
  }) });
  const second = defineFixture({ id: "second", setup: () => ({ value: true,
    teardown: () => { throw hostileValues[0]![1](); },
  }) });
  const report = await executeCase({ spec: spec(), fixtures: [first, second],
    run: () => { throw new Error("earliest body failure"); },
  }, { platform: "web" });
  assert.equal(report.result.error?.message, "earliest body failure");
  assert.deepEqual(cleaned, ["first"]);
  assert.match(diagnostics(report), /Error details could not be read/);
  validReport(report);
});
