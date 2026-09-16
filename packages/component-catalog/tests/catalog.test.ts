import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  componentCatalog,
  fixtureCatalog,
  getComponentManifest,
  listComponentManifests,
  requireComponentManifest,
} from "../src/index.js";

test("publishes 37 unique data manifests instead of empty component classes", () => {
  const ids = componentCatalog.map((manifest) => manifest.id);
  const counts = componentCatalog.reduce<Record<string, number>>((result, manifest) => {
    result[manifest.kind] = (result[manifest.kind] ?? 0) + 1;
    return result;
  }, {});

  assert.equal(componentCatalog.length, 37);
  assert.deepEqual(counts, { common: 15, system: 8, agent: 14 });
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(componentCatalog.every((manifest) => manifest.actions.length > 0), true);
  assert.equal(componentCatalog.every((manifest) => manifest.assertions.length > 0), true);
});

test("every semantic component declares a Windows implementation surface", () => {
  assert.equal(
    componentCatalog.every((manifest) => manifest.platforms.includes("windows")),
    true,
  );
});

test("queries by component family and execution policy", () => {
  const safeAgentComponents = listComponentManifests({
    kind: "agent",
    platform: "windows",
    maximumSideEffectLevel: "reversible",
  });

  assert.deepEqual(
    safeAgentComponents.map((manifest) => manifest.id),
    [
      "desktop.agent.conversation",
      "desktop.agent.streaming-response",
      "desktop.agent.emergency-stop",
    ],
  );
});

test("looks up components and fails clearly for unknown ids", () => {
  assert.equal(
    getComponentManifest("desktop.system.elevation-authorization")?.kind,
    "system",
  );
  assert.throws(() => requireComponentManifest("desktop.agent.unknown"), /Unknown/);
});

test("publishes the WebView bridge without naming a browser implementation", () => {
  const manifest = requireComponentManifest("desktop.common.web-view");

  assert.deepEqual(manifest.requiredCapabilities, [
    "ui.inspect",
    "browser.dom.inspect",
  ]);
  assert.deepEqual(
    manifest.actions.map((action) => action.name),
    ["requireLoaded", "bridgeToBrowserBackend"],
  );
  assert.equal(JSON.stringify(manifest).includes("Playwright"), false);
});

test("discovers components by deterministic fixture requirement", () => {
  assert.deepEqual(
    listComponentManifests({ fixture: "agent.side-effect-probe" }).map(
      (manifest) => manifest.id,
    ),
    [
      "desktop.agent.tool-call",
      "desktop.agent.approval",
      "desktop.agent.emergency-stop",
      "desktop.agent.terminal",
    ],
  );
});

test("all component fixture references resolve in the fixture metadata catalog", () => {
  const ids = fixtureCatalog.map((fixture) => fixture.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    componentCatalog.every((manifest) =>
      (manifest.requiredFixtures ?? []).every((fixture) =>
        ids.includes(fixture as (typeof ids)[number]),
      ),
    ),
    true,
  );
});

test("exports the catalog as consumable JSON", async () => {
  const jsonPath = new URL("../dist/catalog.json", import.meta.url);
  const exported = JSON.parse(await readFile(jsonPath, "utf8")) as unknown[];

  assert.equal(exported.length, componentCatalog.length);

  const fixturesPath = new URL("../dist/fixtures.json", import.meta.url);
  const exportedFixtures = JSON.parse(
    await readFile(fixturesPath, "utf8"),
  ) as unknown[];
  assert.equal(exportedFixtures.length, fixtureCatalog.length);
});
