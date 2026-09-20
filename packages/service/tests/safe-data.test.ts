import assert from "node:assert/strict";
import test from "node:test";

import { SafeDataError, safeDataLimits } from "../src/safe-data.js";
import { validateTestDefinition } from "../src/validate-definition.js";
import { validDefinition } from "./fixtures.js";

test("unknown root fields are rejected before unrelated values are deep-cloned", () => {
  const definition = validDefinition();
  let deep: unknown = "leaf";
  for (let index = 0; index < 100; index += 1) deep = { next: deep };
  definition.unexpected = deep;

  assert.throws(
    () => validateTestDefinition(definition),
    /unknown field unexpected/u,
  );
});

test("a 50k-deep graph fails with structured TypeError instead of RangeError", () => {
  const definition = validDefinition();
  let deep: unknown = "leaf";
  for (let index = 0; index < 50_000; index += 1) deep = { next: deep };
  definition.title = deep;

  assert.throws(() => validateTestDefinition(definition), (error: unknown) => {
    assert.ok(error instanceof SafeDataError);
    assert.ok(error instanceof TypeError);
    assert.ok(!(error instanceof RangeError));
    assert.equal(error.code, "budget");
    assert.match(error.message, /depth budget/u);
    return true;
  });
});

test("node, string-byte, array-item and object-field budgets fail closed", () => {
  const nodeHeavy = validDefinition();
  nodeHeavy.title = Array.from(
    { length: 1_000 },
    () => Array.from({ length: 11 }, () => null),
  );
  assertBudget(nodeHeavy, /node budget/u);

  const stringHeavy = validDefinition();
  stringHeavy.description = "界".repeat(safeDataLimits.maxStringBytes);
  assertBudget(stringHeavy, /string-byte budget/u);

  const arrayHeavy = validDefinition();
  arrayHeavy.caseSpecs = new Array(safeDataLimits.maxCollectionEntries + 1).fill(null);
  assertBudget(arrayHeavy, /item budget/u);

  const objectHeavy = validDefinition();
  const fields: Record<string, null> = {};
  for (let index = 0; index <= safeDataLimits.maxCollectionEntries; index += 1) {
    fields[`field${index}`] = null;
  }
  objectHeavy.title = fields;
  assertBudget(objectHeavy, /field budget/u);
});

test("large collection budgets reject before materializing or invoking descriptors", () => {
  let getterCalls = 0;
  const arrayDefinition = validDefinition();
  const hugeArray = new Array<unknown>(200_000);
  Object.defineProperty(hugeArray, "0", {
    enumerable: true,
    configurable: true,
    get() { getterCalls += 1; return { id: "case.never-read" }; },
  });
  arrayDefinition.caseSpecs = hugeArray;
  assertBudget(arrayDefinition, /item budget/u);
  assert.equal(getterCalls, 0);

  const objectDefinition = validDefinition();
  const hugeObject: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hugeObject, "danger", {
    enumerable: true,
    configurable: true,
    get() { getterCalls += 1; return "never-read"; },
  });
  for (let index = 0; index < 199_999; index += 1) {
    hugeObject[`field${index}`] = null;
  }
  objectDefinition.title = hugeObject;
  assertBudget(objectDefinition, /field budget/u);
  assert.equal(getterCalls, 0);
});

test("shared object references are rejected rather than expanded repeatedly", () => {
  const definition = validDefinition();
  const shared = { id: "case.shared" };
  definition.caseSpecs = [shared, shared];

  assert.throws(() => validateTestDefinition(definition), (error: unknown) => {
    assert.ok(error instanceof SafeDataError);
    assert.equal(error.code, "cycle-or-shared-reference");
    return true;
  });
});

function assertBudget(definition: Record<string, unknown>, message: RegExp): void {
  assert.throws(() => validateTestDefinition(definition), (error: unknown) => {
    assert.ok(error instanceof SafeDataError);
    assert.equal(error.code, "budget");
    assert.match(error.message, message);
    return true;
  });
}
