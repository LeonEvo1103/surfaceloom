import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const macContract = JSON.parse(
  await readFile(new URL("../fixture-contract.v1.json", import.meta.url), "utf8"),
);
const windowsContract = JSON.parse(
  await readFile(new URL("../../windows-fixture/fixture-contract.v1.json", import.meta.url), "utf8"),
);

test("contract declares a product-neutral macOS AppKit fixture", () => {
  assert.equal(macContract.schemaVersion, "surfaceloom.macos-fixture/1");
  assert.equal(macContract.platform, "macos");
  assert.equal(macContract.framework, "appkit");
  assert.equal(macContract.minimumOSVersion, "13.0");
  assert.equal(macContract.productNeutral, true);
  assert.equal(macContract.liveEvidenceRequired, true);
});

test("initial state and all transitions match the Windows reference behavior", () => {
  assert.deepEqual(macContract.initialState, windowsContract.initialState);
  assert.deepEqual(macContract.transitions, windowsContract.transitions);
});

test("control semantics and stable identifiers match the Windows reference", () => {
  const project = (control) => ({
    key: control.key,
    controlType: control.controlType,
    automationId: control.automationId,
    name: control.name,
    action: control.action,
    readOnly: control.readOnly,
    initialValue: control.initialValue,
  });
  assert.deepEqual(macContract.controls.map(project), windowsContract.controls.map(project));
  assert.equal(macContract.root.automationId, windowsContract.root.automationId);
  assert.equal(macContract.root.controlType, windowsContract.root.controlType);
});

test("strict ambiguous locator has two candidates and no declared side effect", () => {
  const transition = macContract.transitions.find((item) => item.operation === "findStrict");
  assert.ok(transition);
  const candidates = macContract.controls.filter(
    (control) =>
      control.controlType === transition.locator.controlType && control.name === transition.locator.name,
  );
  assert.equal(candidates.length, 2);
  assert.equal(transition.postcondition.error, "ambiguous");
  assert.equal(transition.postcondition.sideEffects, 0);
});
