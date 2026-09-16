import assert from "node:assert/strict";
import test from "node:test";

import {
  defineLocator,
  desktopCapabilities,
  desktopPlatforms,
  hasCapability,
  isAppTarget,
  missingCapabilities,
  resolveLocatorMatchPolicy,
  testPlatforms,
  webCapabilities,
  webPlatforms,
  type LaunchOptions,
} from "../src/index.js";

test("accepts macOS and Windows app targets without product-specific fields", () => {
  assert.equal(
    isAppTarget({
      id: "sample.mac",
      displayName: "Sample Mac App",
      platform: "macos",
      bundleId: "org.example.Sample",
    }),
    true,
  );
  assert.equal(
    isAppTarget({
      id: "sample.windows",
      displayName: "Sample Windows App",
      platform: "windows",
      executablePath: "C:\\Apps\\Sample.exe",
    }),
    true,
  );
  assert.equal(
    isAppTarget({ id: "broken", displayName: "Broken", platform: "windows" }),
    false,
  );
});

test("keeps the desktop platform list unchanged while web extends the test platforms", () => {
  assert.deepEqual([...desktopPlatforms], ["macos", "windows"]);
  assert.deepEqual([...webPlatforms], ["web"]);
  assert.deepEqual([...testPlatforms], ["macos", "windows", "web"]);
});

test("keeps web capabilities a subset of the single capability registry", () => {
  for (const capability of webCapabilities) {
    assert.ok(
      desktopCapabilities.includes(capability),
      `${capability} must be registered in desktopCapabilities`,
    );
  }
  assert.equal(new Set(webCapabilities).size, webCapabilities.length);
});

test("resolves the browser observation capabilities added for web runs", () => {
  const available = [
    "browser.navigate",
    "browser.network.observe",
    "browser.console.observe",
  ] as const;

  assert.equal(hasCapability(available, "browser.network.observe"), true);
  assert.equal(hasCapability(available, "browser.network.proxy"), false);
  assert.deepEqual(
    missingCapabilities(available, [
      "browser.console.observe",
      "browser.network.proxy",
      "browser.storage.export",
    ]),
    ["browser.network.proxy", "browser.storage.export"],
  );
});

test("keeps locators semantic and rejects invalid ordinal indexes", () => {
  const locator = defineLocator({
    key: "composer.send",
    role: "button",
    name: { value: "Send", mode: "exact" },
    scope: { kind: "activeWindow" },
  });

  assert.equal(locator.key, "composer.send");
  assert.deepEqual(resolveLocatorMatchPolicy(locator), { kind: "strict" });
  assert.deepEqual(
    resolveLocatorMatchPolicy(
      defineLocator({ key: "conversation.second", match: { kind: "index", index: 1 } }),
    ),
    { kind: "index", index: 1 },
  );
  assert.throws(
    () => defineLocator({ key: "invalid", index: -1 }),
    /non-negative integer/,
  );
  assert.throws(
    () =>
      defineLocator({
        key: "invalid",
        match: { kind: "strict" },
        index: 0,
      }),
    /both match and deprecated index/,
  );
  assert.throws(
    () =>
      defineLocator({
        key: "invalid-policy",
        match: { kind: "first" },
      } as never),
    /Unknown locator match policy/,
  );

  const mutable: {
    key: string;
    match: { kind: "index"; index: number };
    state: { enabled: boolean };
  } = {
    key: "stable-copy",
    match: { kind: "index", index: 1 },
    state: { enabled: true },
  };
  const frozen = defineLocator(mutable);
  mutable.match.index = -1;
  mutable.state.enabled = false;
  assert.deepEqual(frozen.match, { kind: "index", index: 1 });
  assert.deepEqual(frozen.state, { enabled: true });
});

test("allows locators to start at the desktop accessibility root", () => {
  const systemDialog = defineLocator({
    key: "system.openDialog",
    role: "dialog",
    scope: { kind: "desktop" },
  });

  assert.deepEqual(systemDialog.scope, { kind: "desktop" });
});

test("carries adapter-provided environment and profile isolation", () => {
  const options: LaunchOptions = {
    environment: { SAMPLE_PROFILE_MODE: "isolated" },
    profileIsolation: {
      kind: "isolated",
      directory: "/tmp/desktop-test-profile",
    },
  };

  assert.equal(options.environment?.SAMPLE_PROFILE_MODE, "isolated");
  assert.equal(options.profileIsolation?.kind, "isolated");
});

test("reports missing driver capabilities", () => {
  const available = ["ui.inspect", "ui.invoke"] as const;

  assert.equal(hasCapability(available, "ui.invoke"), true);
  assert.deepEqual(
    missingCapabilities(available, ["ui.invoke", "keyboard.inject"]),
    ["keyboard.inject"],
  );
});
