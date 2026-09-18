import assert from "node:assert/strict";
import test from "node:test";

import type {
  BrowserSurfaceBackendPort,
  BrowserSurfaceRequirement,
  SurfaceBackendCall,
} from "@surfaceloom/test";
import {
  createPlaywrightBrowserSurfaceBackend,
  PlaywrightBrowserSurfaceBackend,
} from "@surfaceloom/browser-playwright/v3";
import { BrowserAutomationError } from "@surfaceloom/browser-playwright";

import { FakeBrowserType, fakePlaywright } from "./fakes.js";

const requirement: BrowserSurfaceRequirement = {
  kind: "browser",
  surfaceId: "page",
  expectedHostId: "playwright.local",
  capabilities: ["browser.dom.inspect", "browser.dom.invoke"],
  engine: "chromium",
  headless: true,
  timeoutMs: 1_000,
};

test("is structurally the public v3 port and submits only at Playwright launch", async () => {
  const events: string[] = [];
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const originalLaunch = browserType.launch.bind(browserType);
  browserType.launch = async (options) => {
    events.push("playwright.launch");
    return originalLaunch(options);
  };
  const port: BrowserSurfaceBackendPort = new PlaywrightBrowserSurfaceBackend({
    loader: async () => { events.push("loader"); return module; },
  });
  const session = await port.launch(requirement, call(events, 321));

  assert.deepEqual(events, ["loader", "beforeSubmit", "playwright.launch"]);
  assert.equal(browserType.launchOptions?.timeout, 321);
  assert.equal(session.identity.hostId, port.hostId);
  assert.match(session.identity.sessionId, /^playwright-[0-9a-f-]{36}$/u);
  const proof = await session.close();
  assert.deepEqual(proof, { kind: "browserSessionClosed", ...session.identity });
});

test("preferred factory returns the descriptor-only port required by runCaseV3", () => {
  const port = createPlaywrightBrowserSurfaceBackend({ loader: async () => fakePlaywright() });
  assert.equal(Object.getPrototypeOf(port), Object.prototype);
  assert.equal(Object.isFrozen(port), true);
  assert.deepEqual(Object.keys(port), ["hostId", "capabilities", "launch"]);
});

test("loader and option failures happen before submission", async () => {
  let submissions = 0;
  const callContext = call([], 100, () => { submissions += 1; });
  const missing = new PlaywrightBrowserSurfaceBackend({ loader: async () => {
    throw new Error("missing");
  } });
  await assert.rejects(missing.launch(requirement, callContext), (error: unknown) =>
    error instanceof BrowserAutomationError && error.code === "dependencyUnavailable");
  assert.equal(submissions, 0);

  const invalidEngine = { ...requirement, engine: "invalid" } as never;
  await assert.rejects(new PlaywrightBrowserSurfaceBackend({
    loader: async () => { throw new Error("loader must not run"); },
  }).launch(invalidEngine, callContext), /Unsupported browser engine/);
  assert.equal(submissions, 0);
});

test("pre-submit cancellation error is preserved instead of normalized as Playwright failure", async () => {
  const module = fakePlaywright();
  const expected = new Error("surface deadline before submission");
  const port = new PlaywrightBrowserSurfaceBackend({ loader: async () => module });
  await assert.rejects(port.launch(requirement, {
    signal: new AbortController().signal,
    beforeSubmit: () => { throw expected; },
  }), (error) => error === expected);
  assert.equal((module.chromium as FakeBrowserType).launchOptions, undefined);
});

test("strict preflight never submits ambiguous or missing actions", async () => {
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const port = new PlaywrightBrowserSurfaceBackend({ loader: async () => module });
  const session = await port.launch(requirement, call([], 1_000));
  const target = browserType.browser.context.page.target;

  for (const matches of [0, 2]) {
    let submissions = 0;
    target.matches = matches;
    await assert.rejects(session.invoke({ kind: "click", locator: {
      kind: "testId", key: "action", value: "action",
    } }, call([], 100, () => { submissions += 1; })), (error: unknown) =>
      error instanceof BrowserAutomationError
        && error.code === (matches === 0 ? "targetNotFound" : "ambiguousTarget"));
    assert.equal(submissions, 0);
  }
  await session.close();
});

test("all v3 actions submit once at the Playwright operation and preserve locator strictness", async () => {
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const session = await new PlaywrightBrowserSurfaceBackend({ loader: async () => module })
    .launch(requirement, call([], 1_000));
  const page = browserType.browser.context.page;
  const actions = [
    { kind: "navigate" as const, url: "https://example.test" },
    { kind: "fill" as const, locator: { kind: "label" as const, key: "name", value: "Name" }, value: "Ada" },
    { kind: "click" as const, locator: { kind: "role" as const, key: "button", value: "button" } },
    { kind: "readText" as const, locator: { kind: "text" as const, key: "status", value: "Ready" } },
    { kind: "waitVisible" as const, locator: { kind: "css" as const, key: "ready", value: "#ready" } },
  ];
  for (const action of actions) {
    const events: string[] = [];
    await session.invoke(action, call(events, 77));
    assert.deepEqual(events, ["beforeSubmit"]);
  }
  assert.deepEqual(page.resolutions, [
    "label:Name:true",
    "role:button::undefined",
    "text:Ready:true",
    "css:#ready",
  ]);
  assert.equal(page.target.calls.filter((entry) => entry === "count").length, 3);
  await session.close();
});

test("close proof is emitted only after complete close and failure remains sticky", async () => {
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const port = new PlaywrightBrowserSurfaceBackend({ loader: async () => module });
  const session = await port.launch(requirement, call([], 1_000));
  const failure = new Error("browser close failed");
  browserType.browser.close = async () => { throw failure; };

  const first = session.close();
  const second = session.close();
  assert.equal(first, second);
  await assert.rejects(first, (error: unknown) =>
    error instanceof BrowserAutomationError && error.code === "operationFailed");
  await assert.rejects(session.close(), (error: unknown) =>
    error instanceof BrowserAutomationError && error.code === "operationFailed");
  assert.equal(browserType.browser.context.closeCount, 1);
  assert.equal(browserType.browser.closeCount, 0);
});

test("newPage failure starts browser close even while context close is hanging", async () => {
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const contextClosed = deferred<void>();
  browserType.browser.context.newPageFailure = new Error("page fixture failure");
  browserType.browser.context.close = () => contextClosed.promise;
  const pending = new PlaywrightBrowserSurfaceBackend({ loader: async () => module })
    .launch(requirement, call([], 1_000));
  await delay(1);
  assert.equal(browserType.browser.closeCount, 1);
  contextClosed.resolve();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof BrowserAutomationError && error.code === "operationFailed");
});

test("a hanging close produces no proof until both Playwright close calls complete", async () => {
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const contextClosed = deferred<void>();
  browserType.browser.context.close = () => contextClosed.promise;
  const session = await new PlaywrightBrowserSurfaceBackend({ loader: async () => module })
    .launch(requirement, call([], 1_000));
  let settled = false;
  const pending = session.close().then((proof) => { settled = true; return proof; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(browserType.browser.closeCount, 1);
  contextClosed.resolve();
  const proof = await pending;
  assert.equal(browserType.browser.closeCount, 1);
  assert.equal(proof.sessionId, session.identity.sessionId);
});

function call(
  events: string[],
  timeoutMs: number,
  submitted: () => void = () => undefined,
): SurfaceBackendCall {
  const controller = new AbortController();
  let count = 0;
  return {
    signal: controller.signal,
    beforeSubmit: () => {
      count += 1;
      assert.equal(count, 1, "operation submitted more than once");
      submitted();
      events.push("beforeSubmit");
      return { signal: controller.signal, timeoutMs };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
