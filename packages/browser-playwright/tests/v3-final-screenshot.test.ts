import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { defineCaseV3, runCaseV3, type RunCaseV3Result } from "@surfaceloom/test";
import {
  createPlaywrightBrowserRunOptions,
  type PlaywrightBrowserRunBrowserOptions,
} from "@surfaceloom/browser-playwright/v3";

import { FakeBrowserType, fakePlaywright, fakePngBytes } from "./fakes.js";

const shotId = "surfaceloom.screenshot.page";
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const localTest = process.env.SURFACELOOM_BROWSER_SMOKE === "1" ? test : test.skip;

test("failed v3 Case takes one in-memory viewport PNG before the owned browser closes", async (t) => {
  const { module, browserType, events } = instrumented();
  const result = await run(t, { loader: async () => module }, "fail");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(events, ["screenshot", "context.close", "browser.close"]);
  const options = browserType.browser.context.page.screenshotOptions;
  assert.equal(options?.path, undefined);
  assert.equal(options?.type, "png");
  assert.equal(options?.fullPage, false);
  assert.ok(typeof options?.timeout === "number" && options.timeout > 0 && options.timeout <= 2_000);
  const shot = artifact(result);
  assert.equal(shot?.captureStatus, "captured");
  assert.equal(shot?.sensitive, true);
  const bytes = await readFile(path.join(result.bundle.directory, shot!.relativePath!));
  assert.deepEqual(new Uint8Array(bytes), fakePngBytes);
  assert.equal(shot?.sha256, createHash("sha256").update(fakePngBytes).digest("hex"));
});

test("a closed or crashed page is captureFailed and never masks the business failure", async (t) => {
  const { module, browserType } = instrumented();
  browserType.browser.context.page.screenshot = async () => {
    throw new Error("Target page, context or browser has been closed");
  };
  const result = await run(t, { loader: async () => module }, "fail");
  assert.equal(result.exitCode, 1);
  assert.equal(result.cleanup.status, "passed");
  assert.equal(browserType.browser.closeCount, 1);
  assert.equal(finalResult(result).status, "failed");
  assert.match(finalResult(result).error?.message ?? "", /fixture business failure/u);
  assert.equal(artifact(result)?.captureStatus, "captureFailed");
  assert.match(artifact(result)?.captureError ?? "", /could not capture screenshot/u);
});

test("a hung page screenshot cannot hold cleanup past its bounded budget", async (t) => {
  const { module, browserType } = instrumented();
  browserType.browser.context.page.screenshot = () => new Promise<never>(() => undefined);
  const started = performance.now();
  const result = await run(t, { loader: async () => module }, "fail", 300);
  assert.ok(performance.now() - started < 2_000);
  assert.equal(result.cleanup.status, "passed");
  assert.equal(browserType.browser.context.closeCount, 1);
  assert.equal(browserType.browser.closeCount, 1);
  assert.equal(artifact(result)?.captureStatus, "captureFailed");
  assert.match(artifact(result)?.captureError ?? "", /did not complete within/u);
});

test("a passing v3 Case does not touch page.screenshot under the default policy", async (t) => {
  const { module, events } = instrumented();
  const result = await run(t, { loader: async () => module }, "pass");
  assert.equal(result.exitCode, 0);
  assert.equal(events.includes("screenshot"), false);
  assert.equal(artifact(result), undefined);
});

localTest("real headless Chrome attaches a valid failure PNG to the v3 report", async (t) => {
  const result = await run(t, { channel: "chrome" }, "fail", 5_000, true);
  assert.equal(result.exitCode, 1);
  const shot = artifact(result);
  assert.equal(shot?.captureStatus, "captured");
  const bytes = await readFile(path.join(result.bundle.directory, shot!.relativePath!));
  assert.deepEqual([...bytes.subarray(0, 8)], pngSignature);
  assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0, "PNG has no dimensions");
  assert.equal(shot?.sizeBytes, bytes.byteLength);
  assert.equal(shot?.sha256, createHash("sha256").update(bytes).digest("hex"));
});

function instrumented() {
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const events: string[] = [];
  const page = browserType.browser.context.page;
  const screenshot = page.screenshot.bind(page);
  page.screenshot = async (options) => { events.push("screenshot"); return screenshot(options); };
  const context = browserType.browser.context;
  const closeContext = context.close.bind(context);
  context.close = async () => { events.push("context.close"); await closeContext(); };
  const closeBrowser = browserType.browser.close.bind(browserType.browser);
  browserType.browser.close = async () => { events.push("browser.close"); await closeBrowser(); };
  return { module, browserType, events };
}

async function run(t: test.TestContext, browser: PlaywrightBrowserRunBrowserOptions,
  body: "pass" | "fail", cleanupTimeoutMs = 1_000, navigate = false): Promise<RunCaseV3Result> {
  const root = await mkdtemp(path.join(tmpdir(), "playwright-v3-final-shot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition = defineCaseV3({ spec: caseSpec(), run: async (context) => {
    const surface = context.surface("page");
    if (surface.kind !== "browser") throw new Error("Expected browser surface.");
    if (navigate) await surface.perform({ kind: "navigate", url: fixtureURL() });
    await context.criterion("verified", () => {
      if (body === "fail") throw new Error("fixture business failure");
    });
  } });
  return runCaseV3(definition, createPlaywrightBrowserRunOptions({
    spec: definition.spec,
    run: { id: "run-final-shot", title: "Final screenshot",
      app: { id: "browser-fixture", name: "Browser Fixture" } },
    outputDirectory: path.join(root, "report"),
    effects, policy, browser, budgets: { executionTimeoutMs: 10_000, cleanupTimeoutMs },
  }));
}

function finalResult(result: RunCaseV3Result) {
  const attempts = result.bundle.report.tests[0]!.attempts;
  if (attempts.state !== "known") throw new Error("Expected a known attempt.");
  return attempts.items.at(-1)!.result;
}

function artifact(result: RunCaseV3Result) {
  return finalResult(result).artifacts.find((item) => item.id === shotId);
}

function caseSpec() {
  return { id: "playwright.v3.final-shot", locale: "zh-CN", platforms: ["web" as const],
    suite: { id: "playwright.v3", name: "浏览器端口契约" }, name: "失败时自动截图",
    intent: "验证 v3 runner 在关闭浏览器前为失败 Case 采集当前页面截图。", preconditions: [],
    acceptanceCriteria: [{ id: "verified", text: "业务断言结果按夹具设定。" }],
    sideEffect: "externalEffect" as const };
}

const effects = [
  { resource: "browser.session", operation: "execute", boundary: "local",
    securitySensitive: false, recovery: "unknown" },
  { resource: "browser.navigate", operation: "write", boundary: "external",
    securitySensitive: false, recovery: "unknown" },
] as const;

const policy = {
  maximumSideEffect: "externalEffect" as const,
  grants: effects.map((effect) => ({ resource: effect.resource, operations: [effect.operation],
    boundaries: [effect.boundary], allowUnknownRecovery: true })),
};

function fixtureURL(): string {
  const html = "<!doctype html><html lang=\"zh-CN\"><body><h1>失败现场</h1>"
    + "<p data-testid=\"status\">等待审批</p></body></html>";
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
