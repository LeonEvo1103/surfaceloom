import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { desktopCapabilities } from "../../core/src/index.js";
import { browserCapabilities } from "../src/index.js";

test("public declarations do not leak playwright-core types", async () => {
  const declarations = await declarationFiles("dist");
  const source = (await Promise.all(declarations.map((file) => readFile(file, "utf8"))))
    .join("\n");

  assert.doesNotMatch(source, /from ["']playwright-core["']/u);
  assert.doesNotMatch(source, /import\(["']playwright-core["']\)/u);
});

test("legacy root types stay independent while the explicit v3 entry requires test SPI", async () => {
  const legacy = await readFile("dist/index.d.ts", "utf8");
  const v3 = await readFile("dist/v3-port.d.ts", "utf8");
  assert.doesNotMatch(legacy, /@surfaceloom\/test/u);
  assert.match(v3, /@surfaceloom\/test/u);
});

test("Core stays installable without the optional Playwright package", async () => {
  const manifest = JSON.parse(
    await readFile("../core/package.json", "utf8"),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const coreSources = await sourceFiles("../core/src");
  const source = (await Promise.all(coreSources.map((file) => readFile(file, "utf8"))))
    .join("\n");

  assert.equal(manifest.dependencies?.["playwright-core"], undefined);
  assert.equal(manifest.devDependencies?.["playwright-core"], undefined);
  assert.doesNotMatch(source, /playwright(?:-core)?/iu);
  assert.equal(
    browserCapabilities.every((capability) => desktopCapabilities.includes(capability)),
    true,
  );
  assert.equal(browserCapabilities.includes("browser.network.proxy"), true);
  assert.equal(browserCapabilities.includes("screenshot.capture"), true);
});

async function declarationFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await declarationFiles(candidate));
    else if (entry.isFile() && entry.name.endsWith(".d.ts")) files.push(candidate);
  }
  return files;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(directory, entry.name));
}
