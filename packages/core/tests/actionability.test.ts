import assert from "node:assert/strict";
import test from "node:test";

import {
  GuardedElementActions,
  actionabilityChecks,
  defineLocator,
  type ActionabilityRequest,
  type ElementActionBackend,
  type ElementReference,
  type ResolvedElementAction,
} from "../src/index.js";

const locator = defineLocator({ key: "composer.send", role: "button" });
const element: ElementReference = { id: "element-1", locator };

test("resolves actionability before submitting one native action", async () => {
  const events: string[] = [];
  let request: ActionabilityRequest | undefined;
  let submitted: ResolvedElementAction | undefined;
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: actionabilityChecks,
    async resolveActionability(target, value) {
      events.push(`resolve:${target === locator}`);
      request = value;
      return element;
    },
    async performResolvedAction(action) {
      events.push("perform");
      submitted = action;
    },
  };

  const actions = GuardedElementActions.fromBackend(backend);
  assert.equal(Reflect.ownKeys(actions).includes("backend"), false);
  assert.equal((actions as unknown as { backend?: unknown }).backend, undefined);

  await actions.invoke(locator, {
    timeoutMs: 250,
    additionalChecks: ["stable"],
  });

  assert.deepEqual(events, ["resolve:true", "perform"]);
  assert.deepEqual(request, {
    action: "invoke",
    checks: ["attached", "unique", "visible", "enabled", "stable"],
    timeoutMs: 250,
  });
  assert.equal(Object.isFrozen(request), true);
  assert.deepEqual(submitted, { kind: "invoke", target: element });
  assert.equal(submitted?.target, element);
});

test("does not submit a side effect when actionability fails", async () => {
  let submissions = 0;
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: actionabilityChecks,
    async resolveActionability() {
      throw new Error("element stayed disabled");
    },
    async performResolvedAction() {
      submissions += 1;
    },
  };

  await assert.rejects(
    GuardedElementActions.fromBackend(backend).invoke(locator),
    /stayed disabled/,
  );
  assert.equal(submissions, 0);
});

test("force keeps essential checks and text is submitted once unchanged", async () => {
  const requests: ActionabilityRequest[] = [];
  const actions: ResolvedElementAction[] = [];
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: actionabilityChecks,
    async resolveActionability(_target, request) {
      requests.push(request);
      return element;
    },
    async performResolvedAction(action) {
      actions.push(action);
    },
  };

  await GuardedElementActions.fromBackend(backend).typeText(locator, "hello\nworld", {
    force: true,
  });

  assert.deepEqual(requests[0]?.checks, ["attached", "unique"]);
  assert.deepEqual(actions, [
    { kind: "typeText", target: element, text: "hello\nworld" },
  ]);
});

test("invalid options fail before reaching the backend", async () => {
  let calls = 0;
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: actionabilityChecks,
    async resolveActionability() {
      calls += 1;
      return element;
    },
    async performResolvedAction() {
      calls += 1;
    },
  };

  await assert.rejects(
    GuardedElementActions.fromBackend(backend).setValue(locator, "value", {
      timeoutMs: -1,
    }),
    /timeout/,
  );
  assert.equal(calls, 0);
});

test("fails closed when a backend cannot enforce a requested check", async () => {
  let calls = 0;
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: ["attached", "unique", "visible", "enabled"],
    async resolveActionability() {
      calls += 1;
      return element;
    },
    async performResolvedAction() {
      calls += 1;
    },
  };

  await assert.rejects(
    GuardedElementActions.fromBackend(backend).invoke(locator, {
      additionalChecks: ["stable"],
    }),
    /cannot enforce required checks: stable/,
  );
  assert.equal(calls, 0);
});

test("does not re-resolve or replay a failed native action", async () => {
  let resolutions = 0;
  let submissions = 0;
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: actionabilityChecks,
    async resolveActionability() {
      resolutions += 1;
      return element;
    },
    async performResolvedAction() {
      submissions += 1;
      throw new Error("native invoke failed");
    },
  };

  await assert.rejects(
    GuardedElementActions.fromBackend(backend).invoke(locator),
    /native invoke failed/,
  );
  assert.equal(resolutions, 1);
  assert.equal(submissions, 1);
});

test("rejects malformed checks before calling the backend", async () => {
  let calls = 0;
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: actionabilityChecks,
    async resolveActionability() {
      calls += 1;
      return element;
    },
    async performResolvedAction() {
      calls += 1;
    },
  };

  await assert.rejects(
    GuardedElementActions.fromBackend(backend).invoke(locator, {
      additionalChecks: ["telepathic"] as never,
    }),
    /Unknown actionability check/,
  );
  assert.equal(calls, 0);
});

test("rejects an invalid resolved handle before submitting an action", async () => {
  let submissions = 0;
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: actionabilityChecks,
    async resolveActionability() {
      return undefined as never;
    },
    async performResolvedAction() {
      submissions += 1;
    },
  };

  await assert.rejects(
    GuardedElementActions.fromBackend(backend).invoke(locator),
    /invalid resolved element/,
  );
  assert.equal(submissions, 0);
});

test("validates force before resolving the target", async () => {
  let calls = 0;
  const backend: ElementActionBackend = {
    supportedActionabilityChecks: actionabilityChecks,
    async resolveActionability() {
      calls += 1;
      return element;
    },
    async performResolvedAction() {
      calls += 1;
    },
  };

  await assert.rejects(
    GuardedElementActions.fromBackend(backend).invoke(locator, {
      force: "false" as never,
    }),
    /force must be a boolean/,
  );
  assert.equal(calls, 0);
});
