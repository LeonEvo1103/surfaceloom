import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defineProject, preflightResolvedProject, ProjectConfigurationError, resolveProject,
} from "../src/project.js";

test("defineProject freezes snapshots without retaining mutable caller config", () => {
  const cases = ["cases"];
  const input = {
    rootDir: ".", cases, platform: "web" as const, outputDir: "artifacts",
    timeoutMs: 100, typescript: { moduleFormat: "esm" as const },
  };
  const project = defineProject(input);
  cases[0] = "mutated";
  input.typescript.moduleFormat = "commonjs";

  assert.deepEqual(project, {
    rootDir: ".", cases: ["cases"], platform: "web", outputDir: "artifacts",
    timeoutMs: 100, typescript: { moduleFormat: "esm" },
  });
  assert.ok(Object.isFrozen(project));
  assert.ok(Object.isFrozen(project.cases));
  assert.ok(Object.isFrozen(project.typescript));
});

test("resolution freezes CLI-over-config priority and each path base", () => {
  const root = path.resolve("/tmp/surfaceloom-project-priority");
  const project = defineProject({
    cases: ["configured-cases"], platform: "web", outputDir: "configured-report", timeoutMs: 100,
  });
  const configured = resolveProject(project, { configPath: path.join(root, "surfaceloom.config.mjs"), cwd: root });
  assert.deepEqual(configured.sources, [path.join(root, "configured-cases")]);
  assert.equal(configured.outputDir, path.join(root, "configured-report"));
  assert.equal(configured.platform, "web");
  assert.equal(configured.timeoutMs, 100);

  const overridden = resolveProject(project, {
    configPath: "surfaceloom.config.mjs", cwd: root,
    overrides: { sources: ["explicit-cases"], platform: "macos",
      outputDir: "explicit-report", timeoutMs: 250 },
  });
  assert.deepEqual(overridden.sources, [path.join(root, "explicit-cases")]);
  assert.equal(overridden.outputDir, path.join(root, "explicit-report"));
  assert.equal(overridden.platform, "macos");
  assert.equal(overridden.timeoutMs, 250);
  assert.ok(Object.isFrozen(overridden));
});

test("configured and invocation paths cannot escape or alias the project root", () => {
  assert.throws(() => defineProject({ cases: ["../outside"] }), errorCode("pathEscape"));
  assert.throws(() => defineProject({ rootDir: "../outside", cases: ["cases"] }), errorCode("pathEscape"));
  assert.throws(() => defineProject({ cases: ["cases", "./cases"] }), errorCode("duplicatePath"));

  const root = path.resolve("/tmp/surfaceloom-project-containment");
  const project = defineProject({ cases: ["cases"] });
  assert.throws(() => resolveProject(project, {
    configPath: path.join(root, "surfaceloom.config.mjs"), cwd: root,
    overrides: { sources: ["../outside"] },
  }), errorCode("pathEscape"));
});

test("accessors and proxies fail without executing getters or proxy traps", () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "cases", {
    enumerable: true, get: () => { getterCalls += 1; return ["cases"]; },
  });
  assert.throws(() => defineProject(accessor as never), errorCode("accessorField"));
  assert.equal(getterCalls, 0);

  let recordTraps = 0;
  const hostile = new Proxy({ cases: ["cases"] }, {
    getPrototypeOf: () => { recordTraps += 1; throw new Error("hostile prototype"); },
    ownKeys: () => { recordTraps += 1; throw new Error("hostile ownKeys"); },
  });
  assert.throws(() => defineProject(hostile), errorCode("proxyRejected"));
  assert.equal(recordTraps, 0);
  let arrayReads = 0;
  const guardedCases = new Proxy(["cases"], {
    get: () => { arrayReads += 1; throw new Error("array value read"); },
    ownKeys: () => { arrayReads += 1; throw new Error("array keys read"); },
  });
  assert.throws(() => defineProject({ cases: guardedCases }), errorCode("proxyRejected"));
  assert.equal(arrayReads, 0);
});

test("forged project definitions fail closed", () => {
  assert.throws(() => resolveProject({ rootDir: ".", cases: ["cases"] } as never,
    { configPath: "surfaceloom.config.mjs" }), errorCode("undefinedProject"));
});

test("output preflight rejects an existing node_modules symlink to an external directory", async (context) => {
  const parent = await mkdtemp(path.join(tmpdir(), "surfaceloom-output-preflight-"));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "project");
  const external = path.join(parent, "external");
  await Promise.all([mkdir(root), mkdir(external)]);
  await symlink(external, path.join(root, "node_modules"), "dir");
  const resolved = resolveProject(defineProject({
    cases: ["cases"], outputDir: "node_modules/report",
  }), { configPath: path.join(root, "surfaceloom.config.mjs"), cwd: root });

  await assert.rejects(preflightResolvedProject(resolved), errorCode("pathSymlink"));
});

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ProjectConfigurationError
    && error.code === code && error.exitCode === 2;
}
