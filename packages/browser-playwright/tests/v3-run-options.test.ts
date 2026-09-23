import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defineCaseV3,
  ExecutionPolicyError,
  runCaseV3,
  type BrowserSurfaceAuthor,
} from "@surfaceloom/test";
import { createPlaywrightBrowserRunOptions } from "@surfaceloom/browser-playwright/v3";

import { FakeBrowserType, fakePlaywright } from "./fakes.js";

test("preset integrates stable defaults, caller identities, budgets, signal and injected loader", () => {
  const module = fakePlaywright();
  const stop = new AbortController();
  const outputDirectory = path.resolve("preset-report");
  const options = createPlaywrightBrowserRunOptions({
    spec: caseSpec("playwright.preset.options"),
    run: runIdentity("run-preset-options"),
    outputDirectory,
    effects,
    policy,
    signal: stop.signal,
    browser: { loader: async () => module },
  });

  assert.equal(options.platform, "web");
  assert.equal(options.runnerHostId, "surfaceloom.runner");
  assert.deepEqual(options.run.hosts.map(({ id }) => id), [
    "surfaceloom.runner", "playwright.local",
  ]);
  assert.equal(options.surfaces[0]?.kind, "browser");
  assert.equal(options.surfaces[0]?.requirement.surfaceId, "page");
  assert.equal(options.surfaces[0]?.requirement.timeoutMs, 10_000);
  assert.equal(options.execution.timeoutMs, 20_000);
  assert.equal(options.execution.cleanupTimeoutMs, 5_000);
  assert.equal(options.execution.signal, stop.signal);
  assert.equal(options.outputDirectory, outputDirectory);
  assert.equal(options.stagingDirectory, path.resolve("preset-report.staging"));
});

test("preset options run through the public runner and forward browser launch settings", async (t) => {
  const root = await temporary(t);
  const module = fakePlaywright();
  const engine = module.firefox as FakeBrowserType;
  const definition = browserCase("playwright.preset.runner", async (browser) => {
    assert.equal(await browser.perform({ kind: "readText", locator: {
      kind: "testId", key: "fixture.result", value: "result",
    } }), "fixture text");
  });
  const result = await runCaseV3(definition, createPlaywrightBrowserRunOptions({
    spec: definition.spec,
    run: runIdentity("run-preset-runner"),
    outputDirectory: path.join(root, "report"),
    effects,
    policy,
    browser: {
      loader: async () => module,
      engine: "firefox",
      headless: false,
      channel: "fixture-channel",
      arguments: ["--fixture-argument"],
    },
    runner: { hostOS: "linux" },
  }));

  assert.equal(result.exitCode, 0);
  assert.equal(result.bundle.report.status, "passed");
  assert.equal(engine.launchOptions?.headless, false);
  assert.equal(engine.launchOptions?.channel, "fixture-channel");
  assert.deepEqual(engine.launchOptions?.args, ["--fixture-argument"]);
  assert.equal(engine.browser.context.closeCount, 1);
  assert.equal(engine.browser.closeCount, 1);
});

test("preset never derives authorization from declared effects", async (t) => {
  const root = await temporary(t);
  const module = fakePlaywright();
  const engine = module.chromium as FakeBrowserType;
  const definition = browserCase("playwright.preset.denied", async () => undefined);
  const execution = runCaseV3(definition, createPlaywrightBrowserRunOptions({
    spec: definition.spec,
    run: runIdentity("run-preset-denied"),
    outputDirectory: path.join(root, "report"),
    effects,
    policy: { maximumSideEffect: "writesLocal", grants: [] },
    browser: { loader: async () => module },
    runner: { hostOS: "linux" },
  }));

  await assert.rejects(execution, (error: unknown) =>
    error instanceof ExecutionPolicyError && error.code === "resourceDenied");
  assert.equal(engine.launchOptions, undefined);
});

test("invalid preset budgets are rejected by the existing runner before browser launch", async (t) => {
  const root = await temporary(t);
  const module = fakePlaywright();
  const engine = module.chromium as FakeBrowserType;
  const definition = browserCase("playwright.preset.invalid-budget", async () => undefined);
  const execution = runCaseV3(definition, createPlaywrightBrowserRunOptions({
    spec: definition.spec,
    run: runIdentity("run-preset-invalid-budget"),
    outputDirectory: path.join(root, "report"),
    effects,
    policy,
    budgets: { cleanupTimeoutMs: 0 },
    browser: { loader: async () => module },
    runner: { hostOS: "linux" },
  }));

  await assert.rejects(execution, /cleanupTimeoutMs must be finite and between 1/u);
  assert.equal(engine.launchOptions, undefined);
});

test("cleanup failure remains a failed result when the Case body passes", async (t) => {
  const root = await temporary(t);
  const module = fakePlaywright();
  const engine = module.chromium as FakeBrowserType;
  engine.browser.close = async () => { throw new Error("fixture close failure"); };
  const definition = browserCase("playwright.preset.cleanup", async () => undefined);
  const result = await runCaseV3(definition, createPlaywrightBrowserRunOptions({
    spec: definition.spec,
    run: runIdentity("run-preset-cleanup"),
    outputDirectory: path.join(root, "report"),
    effects,
    policy,
    browser: { loader: async () => module },
    runner: { hostOS: "linux" },
  }));

  assert.equal(result.exitCode, 1);
  assert.equal(result.bundle.report.status, "failed");
  assert.equal(engine.browser.context.closeCount, 1);
});

function browserCase(id: string, action: (browser: BrowserSurfaceAuthor) => Promise<void>) {
  return defineCaseV3({ spec: caseSpec(id), run: async (context) => {
    const browser = context.surface("page");
    if (browser.kind !== "browser") throw new Error("Expected browser surface.");
    await action(browser);
    await context.criterion("verified", () => undefined);
  } });
}

function caseSpec(id: string) {
  return {
    id, locale: "zh-CN", platforms: ["web" as const],
    suite: { id: "playwright.preset", name: "浏览器预设契约" },
    name: "浏览器预设保持运行与清理语义",
    intent: "验证薄预设只装配现有浏览器后端和执行内核。",
    preconditions: [],
    acceptanceCriteria: [{ id: "verified", text: "运行结果与实际生命周期一致。" }],
    sideEffect: "writesLocal" as const,
  };
}

function runIdentity(id: string) {
  return { id, title: "Playwright preset run",
    app: { id: "browser-fixture", name: "Browser Fixture" } };
}

const effects = [
  { resource: "browser.session", operation: "execute", boundary: "local",
    securitySensitive: false, recovery: "unknown" },
  { resource: "browser.readText", operation: "read", boundary: "local",
    securitySensitive: false, recovery: "notNeeded" },
] as const;

const policy = {
  maximumSideEffect: "writesLocal" as const,
  grants: effects.map((effect) => ({ resource: effect.resource,
    operations: [effect.operation], boundaries: [effect.boundary],
    allowUnknownRecovery: effect.recovery === "unknown" })),
};

async function temporary(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "playwright-v3-preset-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
