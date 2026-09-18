import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { defineCaseV3, defineExecutionPlan, runCaseV3, type CaseDefinitionV3 } from "@surfaceloom/test";
import { createPlaywrightBrowserSurfaceBackend } from "@surfaceloom/browser-playwright/v3";
import { BrowserAutomationError } from "@surfaceloom/browser-playwright";

const localTest = process.env.SURFACELOOM_BROWSER_SMOKE === "1" ? test : test.skip;

localTest("real headless Chrome executes the public v3 runner and confirms owned cleanup", async (t) => {
  const root = await temporary(t);
  const backend = createPlaywrightBrowserSurfaceBackend({
    hostId: "playwright.live",
    channel: "chrome",
  });
  const definition = defineCaseV3({
    spec: caseSpec("playwright.v3.live"),
    run: async (context) => {
      const browser = context.surface("page");
      if (browser.kind !== "browser") throw new Error("Expected browser surface.");
      await browser.perform({ kind: "navigate", url: fixtureURL() });
      await browser.perform({ kind: "fill", locator: {
        kind: "testId", key: "profile.name", value: "name",
      }, value: "SurfaceLoom" });
      await browser.perform({ kind: "click", locator: {
        kind: "testId", key: "profile.submit", value: "submit",
      } });
      await browser.perform({ kind: "waitVisible", locator: {
        kind: "testId", key: "profile.result", value: "result",
      } });
      assert.equal(await browser.perform({ kind: "readText", locator: {
        kind: "testId", key: "profile.result", value: "result",
      } }), "已提交：SurfaceLoom");
      await context.criterion("verified", () => undefined);
    },
  });
  const result = await runCaseV3(definition, runnerOptions(root, backend, definition));
  assert.equal(result.exitCode, 0);
});

localTest("real v3 locator rejects an ambiguous target without fallback and still closes", async (t) => {
  const root = await temporary(t);
  const backend = createPlaywrightBrowserSurfaceBackend({ hostId: "playwright.live", channel: "chrome" });
  const definition = defineCaseV3({
    spec: caseSpec("playwright.v3.live-strict"),
    run: async (context) => {
      const browser = context.surface("page");
      if (browser.kind !== "browser") throw new Error("Expected browser surface.");
      await browser.perform({ kind: "navigate", url: duplicateURL() });
      await assert.rejects(browser.perform({ kind: "click", locator: {
        kind: "text", key: "duplicate.action", value: "重复操作",
      } }), (error: unknown) =>
        error instanceof BrowserAutomationError && error.code === "ambiguousTarget");
      await context.criterion("verified", () => undefined);
    },
  });
  const result = await runCaseV3(definition, runnerOptions(root, backend, definition));
  assert.equal(result.exitCode, 1);
});

function runnerOptions(root: string, backend: ReturnType<typeof createPlaywrightBrowserSurfaceBackend>,
  definition: CaseDefinitionV3) {
  return {
    platform: "web" as const,
    runnerHostId: "runner-host",
    run: {
      id: "run-playwright-live",
      title: "Playwright v3 live",
      app: { id: "browser-fixture", name: "Browser Fixture" },
      hosts: [
        { id: "runner-host", os: "macos" as const },
        { id: "playwright.live", os: "macos" as const },
      ],
    },
    surfaces: [{
      kind: "browser" as const,
      backend,
      requirement: {
        kind: "browser" as const,
        surfaceId: "page",
        expectedHostId: "playwright.live",
        capabilities: ["browser.navigate", "browser.dom.inspect", "browser.dom.invoke"],
        engine: "chromium" as const,
        headless: true,
        timeoutMs: 10_000,
      },
    }],
    execution: {
      plan: defineExecutionPlan({ spec: definition.spec, requirements: {
        host: { os: ["macos"] }, surfaces: browserEnvironment.surfaces,
      }, effects: browserEffects }),
      environment: browserEnvironment,
      policy: browserPolicy,
      timeoutMs: 20_000,
      cleanupTimeoutMs: 5_000,
    },
    stagingDirectory: path.join(root, "staging"),
    outputDirectory: path.join(root, "report"),
  };
}

function caseSpec(id: string) {
  return {
    id,
    locale: "zh-CN",
    platforms: ["web" as const],
    suite: { id: "playwright.v3", name: "浏览器端口契约" },
    name: "真实浏览器完成动作与清理",
    intent: "验证公开 v3 runner 通过真实 Playwright 执行动作并确认清理。",
    preconditions: [],
    acceptanceCriteria: [{ id: "verified", text: "浏览器动作与严格定位符合预期。" }],
    sideEffect: "externalEffect" as const,
  };
}

const browserEnvironment = {
  platform: "web" as const,
  host: { os: "macos" as const },
  surfaces: { page: { kind: "browser" as const,
    capabilities: ["browser.navigate", "browser.dom.inspect", "browser.dom.invoke"] } },
};

const browserEffects = [
  { resource: "browser.session", operation: "execute", boundary: "local",
    securitySensitive: false, recovery: "unknown" },
  { resource: "browser.navigate", operation: "write", boundary: "external",
    securitySensitive: false, recovery: "unknown" },
  { resource: "browser.fill", operation: "write", boundary: "local",
    securitySensitive: false, recovery: "unknown" },
  { resource: "browser.click", operation: "write", boundary: "local",
    securitySensitive: false, recovery: "unknown" },
  { resource: "browser.waitVisible", operation: "read", boundary: "local",
    securitySensitive: false, recovery: "notNeeded" },
  { resource: "browser.readText", operation: "read", boundary: "local",
    securitySensitive: false, recovery: "notNeeded" },
] as const;

const browserPolicy = {
  maximumSideEffect: "externalEffect" as const,
  grants: browserEffects.map((effect) => ({ resource: effect.resource,
    operations: [effect.operation], boundaries: [effect.boundary],
    allowUnknownRecovery: effect.recovery === "unknown" })),
};

async function temporary(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "playwright-v3-live-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fixtureURL(): string {
  const html = `<!doctype html><html lang="zh-CN"><body>
    <input data-testid="name"><button data-testid="submit">提交</button>
    <p data-testid="result" hidden></p><script>
      document.querySelector('[data-testid="submit"]').addEventListener('click', () => {
        const result = document.querySelector('[data-testid="result"]');
        result.textContent = '已提交：' + document.querySelector('[data-testid="name"]').value;
        result.hidden = false;
      });
    </script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function duplicateURL(): string {
  const html = "<!doctype html><button>重复操作</button><button>重复操作</button>";
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
