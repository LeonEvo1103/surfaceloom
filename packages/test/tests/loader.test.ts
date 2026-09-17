import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CaseModuleLoadRequest } from "../src/loader-contracts.js";
import { loadProjectCases, ProjectLoadError } from "../src/loader.js";
import { defineProject, resolveProject } from "../src/project.js";
import { spec } from "./support.js";

test("compiled ESM and CJS Cases retain existing discovery behavior", async (context) => {
  const root = await temporaryProject(context);
  await Promise.all([
    writeFile(path.join(root, "a.case.mjs"), moduleSource("compiled.esm", false)),
    writeFile(path.join(root, "b.case.cjs"), moduleSource("compiled.cjs", true)),
  ]);
  const result = await loadProjectCases(resolved(root, { cases: ["."] }));
  assert.deepEqual(result.cases.map((entry) => entry.definition.spec.id), ["compiled.esm", "compiled.cjs"]);
  assert.ok(result.cases.every(Object.isFrozen));
});

test("TypeScript loading is explicit, consumer-owned, and format-stable", async (context) => {
  const root = await temporaryProject(context);
  await Promise.all(["a.case.mts", "b.case.cts", "c.case.ts"].map((name) =>
    writeFile(path.join(root, name), "")));
  const requests: CaseModuleLoadRequest[] = [];
  const project = resolved(root, {
    cases: ["."], typescript: { moduleFormat: "esm" },
  });
  const result = await loadProjectCases(project, {
    typescriptRuntime: { id: "consumer.runtime.v1", load: async (request) => {
      requests.push(request);
      return { cases: [{ spec: spec(`typescript.${path.basename(request.filePath)}`), run: () => undefined }] };
    } },
  });
  assert.equal(result.cases.length, 3);
  assert.deepEqual(requests.map(({ filePath, format, language }) =>
    [path.basename(filePath), format, language]), [
    ["a.case.mts", "esm", "typescript"],
    ["b.case.cts", "commonjs", "typescript"],
    ["c.case.ts", "esm", "typescript"],
  ]);
});

test("ambiguous TypeScript and missing runtimes fail before any module executes", async (context) => {
  const root = await temporaryProject(context);
  await Promise.all([
    writeFile(path.join(root, "a.case.mjs"), ""),
    writeFile(path.join(root, "b.case.ts"), ""),
  ]);
  let javascriptLoads = 0;
  await assert.rejects(loadProjectCases(resolved(root, { cases: ["."] }), {
    loadJavaScriptModule: async () => { javascriptLoads += 1; return { cases: [] }; },
  }), loadError("ambiguousTypeScriptModule"));
  assert.equal(javascriptLoads, 0);

  await assert.rejects(loadProjectCases(resolved(root, {
    cases: ["."], typescript: { moduleFormat: "commonjs" },
  }), { loadJavaScriptModule: async () => { javascriptLoads += 1; return { cases: [] }; } }),
  loadError("typescriptRuntimeRequired"));
  assert.equal(javascriptLoads, 0);
});

test("duplicate Case ids across formats fail closed with CLI-error semantics", async (context) => {
  const root = await temporaryProject(context);
  await Promise.all([
    writeFile(path.join(root, "a.case.mjs"), ""),
    writeFile(path.join(root, "b.case.cjs"), ""),
  ]);
  await assert.rejects(loadProjectCases(resolved(root, { cases: ["."] }), {
    loadJavaScriptModule: async () => ({ cases: [{ spec: spec("duplicate.case"), run: () => undefined }] }),
  }), (error: unknown) => error instanceof ProjectLoadError && error.exitCode === 2
    && /Duplicate Case id/u.test(error.message));
});

test("symbolic-link loops and escapes are rejected instead of traversed", async (context) => {
  const root = await temporaryProject(context);
  const cases = path.join(root, "cases");
  await mkdir(cases);
  await writeFile(path.join(cases, "valid.case.mjs"), moduleSource("valid.case", false));
  await symlink(cases, path.join(cases, "loop"), "dir");
  await assert.rejects(loadProjectCases(resolved(root, { cases: ["cases"] })), loadError("symbolicLink"));
});

test("loader option accessors and proxies are rejected without invoking getters or traps", async (context) => {
  const root = await temporaryProject(context);
  await writeFile(path.join(root, "case.case.mjs"), "");
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "loadJavaScriptModule", {
    enumerable: true, get: () => { getterCalls += 1; return async () => ({ cases: [] }); },
  });
  await assert.rejects(loadProjectCases(resolved(root, { cases: ["."] }), accessor),
    (error: unknown) => error instanceof ProjectLoadError && error.exitCode === 2);
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const hostile = new Proxy({}, {
    getPrototypeOf: () => { proxyTraps += 1; throw new Error("hostile prototype"); },
    ownKeys: () => { proxyTraps += 1; throw new Error("hostile options"); },
  });
  await assert.rejects(loadProjectCases(resolved(root, { cases: ["."] }), hostile),
    (error: unknown) => error instanceof ProjectLoadError && error.exitCode === 2);
  assert.equal(proxyTraps, 0);
});

function resolved(root: string, input: Parameters<typeof defineProject>[0]) {
  return resolveProject(defineProject(input), {
    configPath: path.join(root, "surfaceloom.config.mjs"), cwd: root,
  });
}

function moduleSource(id: string, commonjs: boolean): string {
  const payload = JSON.stringify([{ spec: spec(id) }]);
  return commonjs
    ? `module.exports = ${payload}.map((entry) => ({ ...entry, run() {} }));`
    : `export const cases = ${payload}.map((entry) => ({ ...entry, run() {} }));`;
}

async function temporaryProject(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-project-loader-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function loadError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ProjectLoadError && error.code === code && error.exitCode === 2;
}
