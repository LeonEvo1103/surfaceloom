import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { withPreparedArchitectureFixture } from "./support/architecture-fixture.mjs";

const productPath = (...segments) => `${["pro", "jects"].join("")}/${segments.join("/")}`;

test("architecture guard rejects symbolic links in shared source trees", async () => {
  await withPreparedArchitectureFixture(async (root) => {
    const external = path.join(root, "external", "Product.ts");
    await write(external, 'export const product = "sample";\n');
    await link(external, path.join(root, "packages", "core", "src", "Product.ts"));
  }, rejectsSymlink("Product.ts"));
});

test("architecture guard rejects symbolic links in product scenario trees", async () => {
  await withPreparedArchitectureFixture(async (root) => {
    const external = path.join(root, "external", "RawScenario.cs");
    await write(external, "AutomationElement element;\n");
    await link(
      external,
      path.join(root, productPath("sample", "windows", "Tests", "RawScenario.cs")),
    );
  }, rejectsSymlink("RawScenario.cs"));
});

test("architecture guard ignores symbolic links inside generated directories", async () => {
  await withPreparedArchitectureFixture(async (root) => {
    const external = path.join(root, "external", "generated");
    await write(path.join(external, "Product.ts"), 'export const product = "sample";\n');
    const target = path.join(root, "packages", "core", "node_modules");
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(external, target);
  }, (result) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Architecture check passed/u);
  });
});

function rejectsSymlink(fileName) {
  return (result) => {
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /symbolic links are not allowed/u);
    assert.match(result.stderr, new RegExp(fileName, "u"));
  };
}

async function link(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(source, target);
}

async function write(target, contents) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}
