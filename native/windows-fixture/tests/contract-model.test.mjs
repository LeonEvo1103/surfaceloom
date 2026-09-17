import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contractUrl = new URL("../fixture-contract.v1.json", import.meta.url);
const contract = JSON.parse(await readFile(contractUrl, "utf8"));

function applyTransition(state, transition) {
  if (transition.operation === "findStrict") {
    return { ...state };
  }

  switch (transition.target) {
    case "invoke":
      return { ...state, invokeCount: state.invokeCount + 1 };
    case "valueInput":
      return { ...state, inputValue: transition.argument };
    case "transient":
      return { ...state, transientVisible: false };
    case "transientRestore":
      return { ...state, transientVisible: true };
    case "close":
      return { ...state, lifecycleState: "closing" };
    default:
      throw new Error(`unknown transition target: ${transition.target}`);
  }
}

test("contract declares a product-neutral Windows WPF fixture", () => {
  assert.equal(contract.schemaVersion, "surfaceloom.windows-fixture/1");
  assert.equal(contract.platform, "windows");
  assert.equal(contract.framework, "wpf");
  assert.equal(contract.productNeutral, true);
  assert.equal(contract.liveEvidenceRequired, true);
});
test("stable automation ids are unique", () => {
  const ids = [contract.root.automationId, ...contract.controls.map((control) => control.automationId)];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^surfaceloom\.fixture\.[a-z0-9.-]+$/);
  }
});

test("strict ambiguous locator has exactly two candidates and no side effect", () => {
  const transition = contract.transitions.find((item) => item.operation === "findStrict");
  assert.ok(transition);
  const candidates = contract.controls.filter(
    (control) =>
      control.controlType === transition.locator.controlType && control.name === transition.locator.name,
  );
  assert.equal(candidates.length, 2);
  assert.equal(transition.postcondition.error, "ambiguous");
  assert.equal(transition.postcondition.sideEffects, 0);
});

test("modeled transitions produce the declared postconditions", () => {
  let state = { ...contract.initialState };
  for (const transition of contract.transitions) {
    const before = state;
    state = applyTransition(state, transition);
    const postcondition = transition.postcondition;
    if ("delta" in postcondition) {
      assert.equal(state[postcondition.field], before[postcondition.field] + postcondition.delta);
    }
    if (postcondition.equalsArgument) {
      assert.equal(state[postcondition.field], transition.argument);
    }
    if ("equals" in postcondition) {
      assert.equal(state[postcondition.field], postcondition.equals);
    }
  }
});
