import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverRepositoryContractTests } from "../lib/repository-contract-discovery.mjs";

const productPath = (...segments) => `${["pro", "jects"].join("")}/${segments.join("/")}`;

test("products with native cases must register product contracts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-contracts-"));
  try {
    await write(root, "scripts/tests/shared.test.mjs", "export {};\n");
    await write(root, productPath("sample", "Tests", "Smoke.swift"), "struct Smoke {}\n");

    await assert.rejects(
      discoverRepositoryContractTests(root),
      /Product 'sample'.*no product contract tests/u,
    );

    await write(
      root,
      productPath("sample", "contracts", "catalog.test.mjs"),
      "export {};\n",
    );
    const discovered = await discoverRepositoryContractTests(root);
    assert.deepEqual(
      discovered.map((item) => path.relative(root, item).split(path.sep).join("/")),
      [
        productPath("sample", "contracts", "catalog.test.mjs"),
        "scripts/tests/shared.test.mjs",
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CaseSpecs also require a product contract even without native sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-cases-"));
  try {
    await write(root, productPath("sample", "cases", "smoke.case-spec.json"), "{}\n");
    await assert.rejects(
      discoverRepositoryContractTests(root),
      /Product 'sample'.*no product contract tests/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlinked product Tests cannot bypass contract registration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-linked-tests-"));
  try {
    await write(root, "scripts/tests/shared.test.mjs", "export {};\n");
    await write(root, "external-tests/Smoke.swift", "struct Smoke {}\n");
    const product = path.join(root, productPath("sample"));
    await mkdir(product, { recursive: true });
    await symlink(path.join(root, "external-tests"), path.join(product, "Tests"));

    await assert.rejects(
      discoverRepositoryContractTests(root),
      /Symbolic links are not allowed.*Tests/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}
