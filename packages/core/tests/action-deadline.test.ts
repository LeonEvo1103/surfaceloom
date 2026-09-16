import assert from "node:assert/strict";
import test from "node:test";

import {
  GuardedElementActions,
  actionabilityChecks,
  defineLocator,
  type ElementActionBackend,
  type ElementReference,
} from "../src/index.js";

const locator = defineLocator({ key: "deadline.target" });
const element: ElementReference = { id: "element-1", locator };

test("a late async resolution never submits a native action", async () => {
  let submissions = 0;
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: actionabilityChecks,
    async resolveActionability() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return element;
    },
    async performResolvedAction() {
      submissions += 1;
    },
  };

  await assert.rejects(
    GuardedElementActions.fromBackend(backend).invoke(locator, { timeoutMs: 1 }),
    /timed out after 1ms/,
  );
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(submissions, 0);
});

test("the deadline starts before synchronous backend work", async () => {
  let submissions = 0;
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: actionabilityChecks,
    async resolveActionability() {
      const stopAt = performance.now() + 20;
      while (performance.now() < stopAt) {
        // Simulate a native bridge blocking before it returns a Promise.
      }
      return element;
    },
    async performResolvedAction() {
      submissions += 1;
    },
  };

  await assert.rejects(
    GuardedElementActions.fromBackend(backend).invoke(locator, { timeoutMs: 1 }),
    /timed out after 1ms/,
  );
  assert.equal(submissions, 0);
});
