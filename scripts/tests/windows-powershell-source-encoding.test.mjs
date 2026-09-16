import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findSourceTreeFiles } from "../lib/source-tree-files.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("PowerShell sources stay ASCII-safe for Windows PowerShell 5.1", async () => {
  const sources = await findSourceTreeFiles(
    repositoryRoot,
    (_, name) => /\.ps(?:1|m1|d1)$/iu.test(name),
  );
  assert.ok(sources.length > 0);
  const nonAsciiSources = [];
  for (const sourcePath of sources) {
    const bytes = await readFile(sourcePath);
    if (bytes.some((byte) => byte > 0x7f)) {
      nonAsciiSources.push(path.relative(repositoryRoot, sourcePath));
    }
  }
  assert.deepEqual(
    nonAsciiSources,
    [],
    "WinPS 5.1 reads BOM-less UTF-8 source through the active ANSI code page",
  );
});
