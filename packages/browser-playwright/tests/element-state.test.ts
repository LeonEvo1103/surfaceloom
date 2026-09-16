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

test("separates an absent target from a present but unclickable one", async () => {
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const session = await new PlaywrightBrowserBackend(async () => module).launch();
  const page = browserType.browser.context.page;
  const download = defineDomLocator({
    key: "download.primary",
    kind: "role",
    role: "button",
    name: "下载",
  });

  assert.deepEqual(await session.elementState(download), {
    present: true,
    visible: true,
    enabled: true,
    clickable: true,
  });

  page.target.matches = 0;
  const absent = await session.elementState(download);
  assert.deepEqual(absent, {
    present: false,
    visible: false,
    enabled: false,
    clickable: false,
  });

  page.target.matches = 1;
  page.target.enabled = false;
  const disabled = await session.elementState(download);
  assert.deepEqual(disabled, {
    present: true,
    visible: true,
    enabled: false,
    clickable: false,
  });

  page.target.enabled = true;
  page.target.visible = false;
  const hidden = await session.elementState(download);
  assert.deepEqual(hidden, {
    present: true,
    visible: false,
    enabled: true,
    clickable: false,
  });

  // A checker grades product faults against its own faults, so the two
  // unclickable causes must never collapse into one observation.
  assert.equal(absent.present, false);
  assert.equal(disabled.present, true);
  assert.notDeepEqual(absent, disabled);
  assert.notDeepEqual(disabled, hidden);
  await session.close();
});

test("reads one element's visibility and enablement, not two elements'", async () => {
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  const session = await new PlaywrightBrowserBackend(async () => module).launch();
  const page = browserType.browser.context.page;
  const download = defineDomLocator({
    key: "download.primary",
    kind: "role",
    role: "link",
    name: "macOS",
  });

  // The page swaps the link on the third resolution. A locator re-queries on
  // every call, so an implementation that counts, then asks the locator for
  // visibility, then asks it again for enablement, reads the third answer off
  // a different element and reports a combination the page never showed --
  // here `visible: true, enabled: false`, which the download watch grades as
  // "rendered but dead", pages a human, and is wrong. The fake makes that
  // race deterministic; in a real Chromium (Playwright v1.63.0) it is merely
  // frequent -- on a page whose only link is either fully present or wholly
  // absent, the same defect returned `present: true, visible: false` on 59 of
  // 300 reads, and on 0 of 300 once the element was pinned first.
  page.target.domChanges.push({}, {}, { enabled: false });

  assert.deepEqual(await session.elementState(download), {
    present: true,
    visible: true,
    enabled: true,
    clickable: true,
  });
  // The swap must still be pending: reading it would mean a third resolution.
  assert.equal(page.target.domChanges.length, 1);
  assert.equal(page.target.handles.length, 1);
  assert.equal(page.target.handles[0]?.disposed, true);

  // An element that leaves between the count and the pin is absent, not a
  // rendered control the user is being refused.
  page.target.domChanges.splice(0);
  page.target.enabled = true;
  page.target.domChanges.push({}, { matches: 0 });
  assert.deepEqual(await session.elementState(download), {
    present: false,
    visible: false,
    enabled: false,
    clickable: false,
  });

  await session.close();
});

test("guards element state probes without leaking observed selectors", async () => {
  const module = fakePlaywright();
  const browserType = module.firefox as FakeBrowserType;
  const session = await new PlaywrightBrowserBackend(async () => module).launch({
    engine: "firefox",
  });
  const page = browserType.browser.context.page;
  const secret = defineDomLocator({
    key: "download.primary",
    kind: "css",
    selector: "#token-secret-button",
  });

  await assert.rejects(
    session.elementState(secret, { timeoutMs: -1 }),
    (error: unknown) =>
      error instanceof BrowserAutomationError && error.code === "invalidArgument",
  );

  page.target.matches = 2;
  await assert.rejects(
    session.elementState(secret),
    (error: unknown) =>
      error instanceof BrowserAutomationError &&
      error.code === "ambiguousTarget" &&
      !error.message.includes("token-secret-button"),
  );

  await session.close();
  await assert.rejects(
    session.elementState(secret),
    (error: unknown) =>
      error instanceof BrowserAutomationError && error.code === "sessionClosed",
  );
});
