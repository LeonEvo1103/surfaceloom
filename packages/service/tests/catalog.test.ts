import assert from "node:assert/strict";
import test from "node:test";

import { effectLevels, TestCatalog, validateTestDefinition } from "../src/index.js";
import { validDefinition } from "./fixtures.js";

test("catalog supports explicit zero-to-many CaseSpec references and stable ordering", () => {
  const zero = validDefinition("service-test:zeta/zero");
  const many = validDefinition("service-test:alpha/many");
  many.caseSpecs = [
    { id: "case.login.new", source: "cases/new.case-spec.json" },
    { id: "case.login.old", source: "cases/old.case-spec.json" },
  ];
  const catalog = new TestCatalog([zero, many]);

  assert.deepEqual(catalog.list().map((item) => item.testId), [
    "service-test:alpha/many",
    "service-test:zeta/zero",
  ]);
  assert.equal(catalog.require("service-test:alpha/many").caseSpecs.length, 2);
  assert.equal(catalog.require("service-test:zeta/zero").caseSpecs.length, 0);
});

test("catalog rejects duplicate service test ids without replacing the original", () => {
  const catalog = new TestCatalog([validDefinition()]);
  const duplicate = validDefinition();
  duplicate.title = "Replacement";

  assert.throws(() => catalog.register(duplicate), /Duplicate service testId/u);
  assert.equal(catalog.size, 1);
  assert.equal(catalog.require("service-test:reference/smoke").title, "Reference smoke");
});

test("catalog snapshots and recursively freezes caller data", () => {
  const input = validDefinition();
  const caseSpecs = [{ id: "case.original" }];
  input.caseSpecs = caseSpecs;
  const catalog = new TestCatalog([input]);

  caseSpecs[0]!.id = "case.polluted";
  caseSpecs.push({ id: "case.injected" });
  (input.coverage as { includes: string[] }).includes.push("polluted");

  const stored = catalog.require("service-test:reference/smoke");
  assert.deepEqual(stored.caseSpecs, [{ id: "case.original" }]);
  assert.deepEqual(stored.coverage.includes, ["startup"]);
  assert.ok(Object.isFrozen(stored));
  assert.ok(Object.isFrozen(stored.caseSpecs));
  assert.ok(Object.isFrozen(stored.caseSpecs[0]));
  assert.throws(() => {
    (stored.caseSpecs as { id: string }[]).push({ id: "case.nope" });
  }, TypeError);
});

test("validation rejects accessors without executing them", () => {
  let getterCalls = 0;
  const input = validDefinition();
  Object.defineProperty(input, "title", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "hostile";
    },
  });

  assert.throws(() => validateTestDefinition(input), /accessors are not allowed/u);
  assert.equal(getterCalls, 0);
});

test("validation rejects root and nested Proxies without invoking traps", () => {
  let trapCalls = 0;
  const handler: ProxyHandler<object> = {
    get() { trapCalls += 1; return undefined; },
    getPrototypeOf() { trapCalls += 1; return Object.prototype; },
    ownKeys() { trapCalls += 1; return []; },
    getOwnPropertyDescriptor() { trapCalls += 1; return undefined; },
  };
  const rootProxy = new Proxy(validDefinition(), handler);
  assert.throws(() => validateTestDefinition(rootProxy), /Proxy/u);
  assert.equal(trapCalls, 0);

  const nested = validDefinition();
  nested.coverage = new Proxy(nested.coverage as object, handler);
  assert.throws(() => validateTestDefinition(nested), /Proxy/u);
  assert.equal(trapCalls, 0);
});

test("catalog constructor accepts only a bounded descriptor-read array", () => {
  let calls = 0;
  const iterable = {};
  Object.defineProperty(iterable, Symbol.iterator, {
    get() { calls += 1; return function* iterator() { yield validDefinition(); }; },
  });
  assert.throws(() => new TestCatalog(iterable as unknown as readonly unknown[]), /plain array/u);
  assert.equal(calls, 0);

  const proxied = new Proxy([validDefinition()], {
    get() { calls += 1; return undefined; },
    getPrototypeOf() { calls += 1; return Array.prototype; },
    getOwnPropertyDescriptor() { calls += 1; return undefined; },
    ownKeys() { calls += 1; return []; },
  });
  assert.throws(() => new TestCatalog(proxied), /Proxy/u);
  assert.equal(calls, 0);

  const accessorArray: unknown[] = [];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    configurable: true,
    get() { calls += 1; return validDefinition(); },
  });
  assert.throws(() => new TestCatalog(accessorArray), /accessors are not allowed/u);
  assert.equal(calls, 0);

  assert.throws(
    () => new TestCatalog(new Array<unknown>(1_001).fill(validDefinition())),
    /item budget/u,
  );
});

test("exported effect levels are frozen and validation uses an immutable whitelist", () => {
  assert.ok(Object.isFrozen(effectLevels));
  assert.throws(() => {
    (effectLevels as string[]).push("inventedEffect");
  }, TypeError);
  const definition = validDefinition();
  definition.effect = "inventedEffect";
  assert.throws(() => validateTestDefinition(definition), /unsupported value/u);
});

test("validation rejects malformed definitions and closed-schema violations", () => {
  const mutations: Array<(definition: Record<string, unknown>) => void> = [
    (definition) => { definition.unknown = true; },
    (definition) => { definition.effect = "network-ish"; },
    (definition) => { definition.testId = "submit-button"; },
    (definition) => { definition.caseSpecs = [{ id: "duplicate" }, { id: "duplicate" }]; },
    (definition) => {
      (definition.parameters as Record<string, unknown>).additionalProperties = true;
    },
    (definition) => {
      const parameters = definition.parameters as { required: string[] };
      parameters.required = ["missing"];
    },
    (definition) => {
      const parameters = definition.parameters as {
        properties: { retries: { default: unknown } };
      };
      parameters.properties.retries.default = 1.5;
    },
    (definition) => {
      (definition.requirements as { environment: string[] }).environment = ["secret=value"];
    },
  ];

  for (const mutate of mutations) {
    const definition = validDefinition();
    mutate(definition);
    assert.throws(() => validateTestDefinition(definition));
  }
});
