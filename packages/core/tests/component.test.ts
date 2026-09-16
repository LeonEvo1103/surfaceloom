import assert from "node:assert/strict";
import test from "node:test";

import {
  compareSideEffectLevel,
  defineComponentManifest,
  isSideEffectAtMost,
} from "../src/index.js";

const validManifest = {
  id: "desktop.common.window",
  version: "1.0.0",
  name: "Window",
  summary: "Controls application windows.",
  kind: "common",
  platforms: ["macos", "windows"],
  requiredCapabilities: ["window.inspect"],
  sideEffectLevel: "reversible",
  actions: [{ name: "focus", summary: "Focus a window." }],
  assertions: ["isVisible"],
  locatorKeys: ["window.main"],
  requiredFixtures: ["isolated-profile"],
} as const;

test("defines and freezes a valid component manifest", () => {
  const manifest = defineComponentManifest(validManifest);

  assert.equal(manifest.id, "desktop.common.window");
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.actions), true);
  assert.equal(Object.isFrozen(manifest.requiredFixtures), true);
});

test("rejects duplicate fixture declarations and unknown actionability checks", () => {
  assert.throws(
    () =>
      defineComponentManifest({
        ...validManifest,
        requiredFixtures: ["profile", "profile"],
      }),
    /Duplicate fixture/,
  );
  const invalidData = {
    ...validManifest,
    actions: [
      {
        name: "focus",
        summary: "Focus a window.",
        additionalActionabilityChecks: ["magic"],
      },
    ],
  } as never;
  // The cast exercises runtime validation of data loaded from JSON.
  assert.throws(
    () => defineComponentManifest(invalidData),
    /Unknown actionability check/,
  );
});

test("rejects duplicate machine-readable action names", () => {
  assert.throws(
    () =>
      defineComponentManifest({
        ...validManifest,
        actions: [
          { name: "focus", summary: "Focus a window." },
          { name: "focus", summary: "Focus it again." },
        ],
      }),
    /Duplicate action: focus/,
  );
});

test("rejects actions that exceed the component policy ceiling", () => {
  assert.throws(
    () =>
      defineComponentManifest({
        ...validManifest,
        actions: [
          {
            name: "publish",
            summary: "Publish data externally.",
            sideEffectLevel: "externalEffect",
          },
        ],
      }),
    /exceeds component side-effect level/,
  );
});

test("orders side effects for execution policy gates", () => {
  assert.equal(compareSideEffectLevel("readOnly", "writesLocal") < 0, true);
  assert.equal(isSideEffectAtMost("reversible", "writesLocal"), true);
  assert.equal(isSideEffectAtMost("externalEffect", "writesLocal"), false);
});
