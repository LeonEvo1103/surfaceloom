import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BrowserAutomationError,
  defineDomLocator,
  PlaywrightBrowserBackend,
} from "../src/index.js";
import type {
  PlaywrightBrowserLike,
  PlaywrightContextLike,
  PlaywrightPageLike,
  PlaywrightTracingLike,
} from "../src/playwright-shapes.js";
import { PlaywrightBrowserSession } from "../src/session.js";
import { FakeBrowserType, FakePage, fakePlaywright } from "./fakes.js";

test("resolves semantic DOM locators and requires exactly one action target", async () => {
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const session = await new PlaywrightBrowserBackend(async () => module).launch();
  const page = browserType.browser.context.page;
  const send = defineDomLocator({
    key: "composer.send",
    kind: "role",
    role: "button",
    name: "发送",
    exact: true,
  });

  await session.click(send);
  await session.fill({ key: "form.email", kind: "label", text: "邮箱" }, "a@example.test");
  assert.equal(await session.text({ key: "status", kind: "testId", value: "status" }), "fixture text");
  assert.deepEqual(page.resolutions, [
    "role:button:发送:true",
    "label:邮箱:undefined",
    "testId:status",
  ]);
  assert.equal(page.target.calls.includes("click"), true);
  assert.equal(page.target.calls.includes("fill:a@example.test"), true);

  page.target.matches = 2;
  await assert.rejects(
    session.click(send),
    (error: unknown) =>
      error instanceof BrowserAutomationError && error.code === "ambiguousTarget",
  );
  await session.close();
});

test("maps navigation, waits, missing targets, and closed sessions", async () => {
  const module = fakePlaywright();
  const browserType = module.webkit as FakeBrowserType;
  const session = await new PlaywrightBrowserBackend(async () => module).launch({
    engine: "webkit",
  });
  const result = await session.navigate("https://example.test/page", {
    waitUntil: "domcontentloaded",
  });
  assert.deepEqual(result, { url: "https://example.test/page", status: 200 });
  await session.waitFor({ key: "ready", kind: "text", text: "完成" }, "visible");

  browserType.browser.context.page.target.waitFailure = new Error("token=secret");
  await assert.rejects(
    session.click({ key: "missing", kind: "css", selector: "#missing" }),
    (error: unknown) =>
      error instanceof BrowserAutomationError &&
      error.code === "targetNotFound" &&
      !error.message.includes("secret"),
  );

  await session.close();
  await assert.rejects(session.title(), (error: unknown) =>
    error instanceof BrowserAutomationError && error.code === "sessionClosed"
  );
  assert.throws(() => session.currentURL(), /session is closed/);
});

test("returns sensitive screenshot and trace artifacts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-browser-"));
  try {
    const module = fakePlaywright();
    const browserType = module.chromium as FakeBrowserType;
    const session = await new PlaywrightBrowserBackend(async () => module).launch();
    const screenshotPath = path.join(directory, "page.png");
    const tracePath = path.join(directory, "trace.zip");

    const screenshot = await session.screenshot(screenshotPath, true);
    await session.startTrace();
    const trace = await session.stopTrace(tracePath);

    assert.deepEqual(
      { kind: screenshot.kind, path: screenshot.sourcePath, sensitive: screenshot.sensitive },
      { kind: "screenshot", path: screenshotPath, sensitive: true },
    );
    assert.equal(trace.contentType, "application/zip");
    assert.equal(browserType.browser.context.page.screenshotPath, screenshotPath);
    assert.equal(browserType.browser.context.tracing.stopPath, tracePath);
    await assert.rejects(session.stopTrace(tracePath), /not active/);
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects empty locators and relative artifact paths", async () => {
  assert.throws(
    () => defineDomLocator({ key: "", kind: "text", text: "value" }),
    /must not be empty/,
  );
  const session = await new PlaywrightBrowserBackend(async () => fakePlaywright()).launch();
  await assert.rejects(session.screenshot("relative.png"), /must be absolute/);
  await assert.rejects(
    session.click(
      { key: "button", kind: "role", role: "button" },
      { timeoutMs: -1 },
    ),
    (error: unknown) =>
      error instanceof BrowserAutomationError && error.code === "invalidArgument",
  );
  await session.close();
});
