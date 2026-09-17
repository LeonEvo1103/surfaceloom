import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

type PublicApi = typeof import("../../src/index.js");

const publicEntryUrl = pathToFileURL(path.resolve("dist/index.js")).href;
const publicApi = await import(publicEntryUrl) as PublicApi;
const { loadProjectConfig, ProjectConfigLoadError } = publicApi;

test("built public ESM entry exports the project and config-loader API", () => {
  assert.equal(typeof publicApi.defineProject, "function");
  assert.equal(typeof publicApi.resolveProject, "function");
  assert.equal(typeof publicApi.loadProjectCases, "function");
  assert.equal(typeof publicApi.loadProjectConfig, "function");
  assert.equal(typeof publicApi.runCli, "function");
});

test("config loader accepts real public-entry ESM and asynchronous CommonJS shapes", async (context) => {
  const root = await temporaryDirectory(context);
  const esm = path.join(root, "surfaceloom.config.mjs");
  const cjs = path.join(root, "surfaceloom.config.cjs");
  const js = path.join(root, "surfaceloom.config.js");
  await Promise.all([
    writeFile(esm, `
import { defineProject } from ${JSON.stringify(publicEntryUrl)};
export default defineProject({ cases: ["cases"], platform: "web", outputDir: "report" });
export const typescriptRuntime = { id: "consumer.runtime.v1", async load() { return { cases: [] }; } };
`),
    writeFile(cjs, `
module.exports = import(${JSON.stringify(publicEntryUrl)}).then(({ defineProject }) => ({
  project: defineProject({ cases: ["cases"] })
}));
`),
    writeFile(js, `
module.exports = import(${JSON.stringify(publicEntryUrl)}).then(({ defineProject }) => ({
  project: defineProject({ cases: ["js-cases"] })
}));
`),
  ]);
  const esmConfig = await loadProjectConfig(esm);
  const cjsConfig = await loadProjectConfig(cjs);
  const jsConfig = await loadProjectConfig(js);
  assert.equal(esmConfig.project.platform, "web");
  assert.equal(esmConfig.typescriptRuntime?.id, "consumer.runtime.v1");
  assert.deepEqual(cjsConfig.project.cases, ["cases"]);
  assert.deepEqual(jsConfig.project.cases, ["js-cases"]);
  assert.equal(cjsConfig.typescriptRuntime, undefined);
});

test("synchronous CommonJS config is rejected at the ESM-only package boundary", async (context) => {
  const root = await temporaryDirectory(context);
  const config = path.join(root, "surfaceloom.config.cjs");
  await writeFile(config, `module.exports = { project: {} };`);
  await assert.rejects(loadProjectConfig(config), configCode("synchronousCommonJsConfig"));
});

test("config modules reject ambiguous exports, unbranded values, and runtime accessors", async (context) => {
  const root = await temporaryDirectory(context);
  const ambiguous = path.join(root, "ambiguous.config.mjs");
  const unbranded = path.join(root, "unbranded.config.mjs");
  const accessor = path.join(root, "accessor.config.mjs");
  await Promise.all([
    writeFile(ambiguous, `
import { defineProject } from ${JSON.stringify(publicEntryUrl)};
export default defineProject({ cases: ["cases"] });
export const project = defineProject({ cases: ["other"] });
`),
    writeFile(unbranded, `export default { rootDir: ".", cases: ["cases"] };`),
    writeFile(accessor, `
import { defineProject } from ${JSON.stringify(publicEntryUrl)};
export default defineProject({ cases: ["cases"] });
export const typescriptRuntime = Object.defineProperty({ id: "runtime" }, "load", {
  enumerable: true, get() { throw new Error("runtime getter executed"); }
});
`),
  ]);
  for (const config of [ambiguous, unbranded, accessor]) {
    await assert.rejects(loadProjectConfig(config), cliConfigError);
  }
});

test("config paths reject unsupported TypeScript, relative escape, and symlinks", async (context) => {
  const root = await temporaryDirectory(context);
  const nested = path.join(root, "nested");
  await mkdir(nested);
  const config = path.join(root, "surfaceloom.config.mjs");
  const unsupported = path.join(root, "surfaceloom.config.ts");
  const link = path.join(root, "linked.config.mjs");
  await Promise.all([writeFile(config, "export default {};"), writeFile(unsupported, "export default {};")]);
  await symlink(config, link, "file");
  await assert.rejects(loadProjectConfig(unsupported), configCode("unsupportedConfigModule"));
  await assert.rejects(loadProjectConfig("../surfaceloom.config.mjs", { cwd: nested }),
    configCode("configPathEscape"));
  await assert.rejects(loadProjectConfig(link), configCode("symbolicConfig"));
});

async function temporaryDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "surfaceloom-config-loader-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function configCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ProjectConfigLoadError && error.code === code && error.exitCode === 2;
}

function cliConfigError(error: unknown): boolean {
  return error instanceof ProjectConfigLoadError && error.exitCode === 2;
}
