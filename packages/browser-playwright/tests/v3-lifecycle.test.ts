import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defineCaseV3,
  defineExecutionPlan,
  runCaseV3,
  type BrowserSurfaceAuthor,
  type CaseDefinitionV3,
} from "@surfaceloom/test";
import { createPlaywrightBrowserSurfaceBackend } from "@surfaceloom/browser-playwright/v3";

import { FakeBrowserType, fakePlaywright } from "./fakes.js";

test("runner/controller closes an acquisition that arrives after setup deadline", async (t) => {
  const root = await temporary(t);
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const launched = deferred<Awaited<ReturnType<FakeBrowserType["launch"]>>>();
  browserType.launch = async () => launched.promise;
  const backend = createPlaywrightBrowserSurfaceBackend({ loader: async () => module });

  const subject = definition("playwright.v3.late", async () => undefined);
  await assert.rejects(runCaseV3(subject, runnerOptions(root, backend, subject, {
    surfaceTimeoutMs: 5, cleanupTimeoutMs: 200,
  })));
  // Resolve only after the runner has observed the deadline. Fixed timer gaps
  // become ambiguous when a loaded CI event loop wakes both timers together.
  launched.resolve(browserType.browser);
  await waitUntil(() => browserType.browser.closeCount === 1, 1_000);
  assert.equal(browserType.browser.context.closeCount, 0);
  assert.equal(browserType.browser.closeCount, 1);
});

test("newContext hang still triggers owned browser close after acquisition timeout", async (t) => {
  const root = await temporary(t);
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  browserType.browser.newContext = async () => new Promise<never>(() => undefined);
  const backend = createPlaywrightBrowserSurfaceBackend({ loader: async () => module });
  const subject = definition("playwright.v3.context-hang", async () => undefined);

  await assert.rejects(runCaseV3(subject, runnerOptions(root, backend, subject, {
    surfaceTimeoutMs: 5, cleanupTimeoutMs: 30,
  })));
  assert.equal(browserType.browser.closeCount, 1);
});

test("newPage hang independently closes both acquired context and browser", async (t) => {
  const root = await temporary(t);
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  browserType.browser.context.newPage = async () => new Promise<never>(() => undefined);
  const backend = createPlaywrightBrowserSurfaceBackend({ loader: async () => module });
  const subject = definition("playwright.v3.page-hang", async () => undefined);

  await assert.rejects(runCaseV3(subject, runnerOptions(root, backend, subject, {
    surfaceTimeoutMs: 5, cleanupTimeoutMs: 30,
  })));
  assert.equal(browserType.browser.context.closeCount, 1);
  assert.equal(browserType.browser.closeCount, 1);
});

test("submitted action deadline is unknown, is not replayed, and cleanup is confirmed", async (t) => {
  const root = await temporary(t);
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const clicked = deferred<void>();
  let clicks = 0;
  browserType.browser.context.page.target.click = async () => {
    clicks += 1;
    return clicked.promise;
  };
  const backend = createPlaywrightBrowserSurfaceBackend({ loader: async () => module });
  setTimeout(() => clicked.resolve(), 15);
  const subject = definition("playwright.v3.action-deadline", async (browser) => {
    await browser.perform({ kind: "click", locator: {
      kind: "testId", key: "action", value: "action",
    } }, { timeoutMs: 5 });
  });
  const result = await runCaseV3(subject, runnerOptions(root, backend, subject, {
    surfaceTimeoutMs: 1_000, cleanupTimeoutMs: 200,
  }));

  assert.equal(result.exitCode, 1);
  assert.equal(clicks, 1);
  assert.equal(browserType.browser.context.closeCount, 1);
  assert.equal(browserType.browser.closeCount, 1);
});

test("Playwright close failure cannot become a released runner result", async (t) => {
  const root = await temporary(t);
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  browserType.browser.close = async () => { throw new Error("close fixture failure"); };
  const backend = createPlaywrightBrowserSurfaceBackend({ loader: async () => module });
  const subject = definition("playwright.v3.close-failure", async () => undefined);
  const result = await runCaseV3(subject, runnerOptions(root, backend, subject, {
    surfaceTimeoutMs: 1_000, cleanupTimeoutMs: 200,
  }));
  assert.equal(result.exitCode, 1);
  assert.equal(browserType.browser.context.closeCount, 1);
});

test("pre-submit cancellation during loader preparation never launches Playwright", async (t) => {
  const root = await temporary(t);
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const loaded = deferred<unknown>();
  const stop = new AbortController();
  const backend = createPlaywrightBrowserSurfaceBackend({ loader: () => loaded.promise });
  setTimeout(() => stop.abort(new Error("cancel fixture")), 1);
  setTimeout(() => loaded.resolve(module), 10);

  const subject = definition("playwright.v3.cancel", async () => undefined);
  await assert.rejects(runCaseV3(subject, runnerOptions(root, backend, subject, {
      surfaceTimeoutMs: 1_000,
      cleanupTimeoutMs: 200,
      signal: stop.signal,
    })));
  assert.equal(browserType.launchOptions, undefined);
  assert.equal(browserType.browser.context.closeCount, 0);
  assert.equal(browserType.browser.closeCount, 0);
});

function definition(id: string, action: (browser: BrowserSurfaceAuthor) => Promise<void>) {
  return defineCaseV3({
    spec: caseSpec(id),
    run: async (context) => {
      const browser = context.surface("page");
      if (browser.kind !== "browser") throw new Error("Expected browser surface.");
      await action(browser);
      await context.criterion("verified", () => undefined);
    },
  });
}

function runnerOptions(root: string, backend: ReturnType<typeof createPlaywrightBrowserSurfaceBackend>,
  definition: CaseDefinitionV3, options: {
  readonly surfaceTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly signal?: AbortSignal;
}) {
  return {
    platform: "web" as const,
    runnerHostId: "runner-host",
    run: {
      id: `run-${path.basename(root)}`,
      title: "Playwright v3 lifecycle",
      app: { id: "browser-fixture", name: "Browser Fixture" },
      hosts: [
        { id: "runner-host", os: "macos" as const },
        { id: "playwright.local", os: "macos" as const },
      ],
    },
    surfaces: [{ kind: "browser" as const, backend, requirement: {
      kind: "browser" as const,
      surfaceId: "page",
      expectedHostId: "playwright.local",
      capabilities: ["browser.dom.inspect", "browser.dom.invoke"],
      engine: "chromium" as const,
      headless: true,
      timeoutMs: options.surfaceTimeoutMs,
    } }],
    execution: execution(definition),
    stagingDirectory: path.join(root, "staging"),
    outputDirectory: path.join(root, "report"),
  };

  function execution(subject: CaseDefinitionV3) {
    const environment = { platform: "web" as const, host: { os: "macos" as const }, surfaces: {
      page: { kind: "browser" as const,
        capabilities: ["browser.dom.inspect", "browser.dom.invoke"] },
    } };
    return {
      plan: defineExecutionPlan({ spec: subject.spec, requirements: {
        host: { os: ["macos"] }, surfaces: environment.surfaces,
      }, effects: browserEffects }),
      environment,
      policy: browserPolicy,
      timeoutMs: 1_000,
      cancellationGraceMs: 20,
      cleanupTimeoutMs: options.cleanupTimeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
  }
}

function caseSpec(id: string) {
  return {
    id,
    locale: "zh-CN",
    platforms: ["web" as const],
    suite: { id: "playwright.v3", name: "浏览器端口契约" },
    name: "浏览器生命周期保持保守语义",
    intent: "验证取消、迟到获取、动作超时和清理收据。",
    preconditions: [],
    acceptanceCriteria: [{ id: "verified", text: "生命周期行为符合保守契约。" }],
    sideEffect: "externalEffect" as const,
  };
}

const browserEffects = [
  { resource: "browser.session", operation: "execute", boundary: "local",
    securitySensitive: false, recovery: "unknown" },
  { resource: "browser.click", operation: "write", boundary: "local",
    securitySensitive: false, recovery: "unknown" },
] as const;

const browserPolicy = {
  maximumSideEffect: "externalEffect" as const,
  grants: browserEffects.map((effect) => ({ resource: effect.resource,
    operations: [effect.operation], boundaries: [effect.boundary],
    allowUnknownRecovery: effect.recovery === "unknown" })),
};

async function temporary(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "playwright-v3-lifecycle-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the expected lifecycle state.");
    await delay(5);
  }
}
