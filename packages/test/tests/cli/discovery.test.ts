import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CaseRegistry, defineCase } from "../../src/index.js";
import { discoverCases } from "../../src/cli/index.js";
import { spec } from "../support.js";

test("discovery is recursive, lexical, explicit, and snapshots validated Cases", async (context) => {
  const root = await temporaryDirectory(context);
  await mkdir(path.join(root, "nested"));
  const left = path.join(root, "a.case.js");
  const right = path.join(root, "nested", "b.case.mjs");
  const ignored = path.join(root, "ignored.js");
  const uncompiled = path.join(root, "ignored.case.ts");
  await Promise.all([
    writeFile(left, ""), writeFile(right, ""), writeFile(ignored, ""), writeFile(uncompiled, ""),
  ]);
  const modules = new Map([
    [path.basename(left), { cases: [{ spec: spec("case.a"), run: () => undefined }] }],
    [path.basename(right), { default: new CaseRegistry([
      defineCase({ spec: spec("case.b"), run: () => undefined }),
    ]) }],
  ]);
  const discovered = await discoverCases([root], {
    loadModule: async (url) => modules.get(path.basename(new URL(url).pathname)),
  });
  assert.deepEqual(discovered.map((item) => item.definition.spec.id), ["case.a", "case.b"]);
  assert.ok(discovered.every(Object.isFrozen));
});

async function temporaryDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "surfaceloom-test-discovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("discovery rejects duplicate ids across modules", async (context) => {
  const root = await temporaryDirectory(context);
  await Promise.all([
    writeFile(path.join(root, "a.case.js"), ""),
    writeFile(path.join(root, "b.case.js"), ""),
  ]);
  await assert.rejects(discoverCases([root], {
    loadModule: async () => ({ cases: [{ spec: spec("case.duplicate"), run: () => undefined }] }),
  }), /Duplicate Case id/);
});

test("discovery rejects ambiguous modules instead of scanning arbitrary exports", async (context) => {
  const root = await temporaryDirectory(context);
  const source = path.join(root, "empty.case.js");
  await writeFile(source, "");
  await assert.rejects(discoverCases([source], {
    loadModule: async () => ({ unrelated: defineCase({ spec: spec(), run: () => undefined }) }),
  }), /must export a cases array or CaseRegistry/);
});
