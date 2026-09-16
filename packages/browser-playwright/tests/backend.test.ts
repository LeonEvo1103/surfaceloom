import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserAutomationError,
  PlaywrightBrowserBackend,
} from "../src/index.js";
import type { PlaywrightModuleLike } from "../src/playwright-shapes.js";
import { FakeBrowserType, fakePlaywright } from "./fakes.js";

test("launches an owned browser with isolated context options", async () => {
  const module = fakePlaywright();
  const backend = new PlaywrightBrowserBackend(async () => module);
  const session = await backend.launch({
    engine: "firefox",
    headless: false,
    arguments: ["--fixture"],
    context: {
      baseURL: "https://example.test",
      locale: "zh-CN",
      viewport: { width: 1280, height: 720 },
    },
  });

  const browserType = module.firefox as FakeBrowserType;
  assert.deepEqual(browserType.launchOptions, {
    headless: false,
    args: ["--fixture"],
  });
  assert.deepEqual(browserType.browser.contextOptions, {
    baseURL: "https://example.test",
    locale: "zh-CN",
    viewport: { width: 1280, height: 720 },
  });
  assert.equal(session.engine, "firefox");
  assert.deepEqual(backend.capabilities, [
    "browser.navigate",
    "browser.dom.inspect",
    "browser.dom.invoke",
    "browser.trace",
    "browser.network.proxy",
    "screenshot.capture",
  ]);

  await session.close();
  assert.equal(browserType.browser.context.closeCount, 1);
  assert.equal(browserType.browser.closeCount, 1);
});

test("reports a missing or invalid Playwright dependency clearly", async () => {
  const missing = new PlaywrightBrowserBackend(async () => {
    throw new Error("module missing with secret=hidden");
  });
  await assert.rejects(
    missing.launch(),
    (error: unknown) =>
      error instanceof BrowserAutomationError &&
      error.code === "dependencyUnavailable" &&
      !error.message.includes("hidden"),
  );

  const invalid = new PlaywrightBrowserBackend(async () => ({}));
  await assert.rejects(
    invalid.launch(),
    (error: unknown) =>
      error instanceof BrowserAutomationError && error.code === "dependencyUnavailable",
  );
});

test("cleans up an owned browser when page creation fails", async () => {
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  browserType.browser.context.newPageFailure = new Error("fixture failure");
  const backend = new PlaywrightBrowserBackend(async () => module as PlaywrightModuleLike);

  await assert.rejects(backend.launch(), /could not launch an owned browser/);
  assert.equal(browserType.browser.context.closeCount, 1);
  assert.equal(browserType.browser.closeCount, 1);
});

test("rejects invalid launch options before loading Playwright", async () => {
  let loads = 0;
  const backend = new PlaywrightBrowserBackend(async () => {
    loads += 1;
    return fakePlaywright();
  });

  await assert.rejects(
    backend.launch({ context: { viewport: { width: 0, height: 720 } } }),
    (error: unknown) =>
      error instanceof BrowserAutomationError && error.code === "invalidArgument",
  );
  await assert.rejects(
    backend.launch({ context: { storageStatePath: "relative-state.json" } }),
    /must be absolute/,
  );
  assert.equal(loads, 0);
});
