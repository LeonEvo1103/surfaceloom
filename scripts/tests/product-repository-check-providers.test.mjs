import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadProductRepositoryCheckExtensions,
} from "../lib/product-repository-check-providers.mjs";

async function withProjects(assertion) {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-products-"));
  try {
    await assertion(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("product repository-check providers are discovered in stable order", async () => {
  await withProjects(async (projects) => {
    for (const name of ["zeta", "alpha", "without-provider"]) {
      await mkdir(path.join(projects, name));
    }
    const provider = (id, prefix) => `
      export function defineProductRepositoryChecks(hostPlatform) {
        return {
          checks: [{ spec: { id: "${id}" }, command: hostPlatform, args: [] }],
          suppressedEnvironmentPrefixes: ["${prefix}"],
        };
      }
    `;
    await writeFile(
      path.join(projects, "alpha", "repository-checks.mjs"),
      provider("alpha-check", "ALPHA_"),
    );
    await writeFile(
      path.join(projects, "zeta", "repository-checks.mjs"),
      provider("zeta-check", "ZETA_"),
    );

    const extensions = await loadProductRepositoryCheckExtensions(projects, {
      hostPlatform: "darwin",
    });
    assert.deepEqual(
      extensions.map((extension) => extension.checks[0].spec.id),
      ["alpha-check", "zeta-check"],
    );
    assert.ok(Object.isFrozen(extensions));
  });
});

test("provider symlinks and malformed environment prefixes fail closed", async () => {
  await withProjects(async (projects) => {
    const external = path.join(projects, "external.mjs");
    await writeFile(external, "export const value = true;\n");
    await mkdir(path.join(projects, "linked"));
    await symlink(external, path.join(projects, "linked", "repository-checks.mjs"));
    await assert.rejects(
      loadProductRepositoryCheckExtensions(projects, { hostPlatform: "darwin" }),
      /ordinary file/,
    );
  });

  await withProjects(async (projects) => {
    await mkdir(path.join(projects, "malformed"));
    await writeFile(
      path.join(projects, "malformed", "repository-checks.mjs"),
      `export const defineProductRepositoryChecks = () => ({
        checks: [], suppressedEnvironmentPrefixes: ["unsafe"]
      });`,
    );
    await assert.rejects(
      loadProductRepositoryCheckExtensions(projects, { hostPlatform: "darwin" }),
      /invalid extension/,
    );
  });
});
