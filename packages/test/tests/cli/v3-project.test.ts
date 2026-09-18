import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

type PublicApi = typeof import("../../src/index.js");

const publicEntryUrl = pathToFileURL(path.resolve("dist/index.js")).href;
const { runCli } = await import(publicEntryUrl) as PublicApi;
const run = promisify(execFile);

test("explicit v3 project config invokes runCaseV3 and publishes a native v3 bundle", async (context) => {
  const fixture = await projectFixture(context, "pass");
  const io = output();
  const exitCode = await runCli(["--config", fixture.config, "--run-id", "cli.v3.pass"], io);
  const report = JSON.parse(await readFile(path.join(fixture.output, "report.json"), "utf8")) as {
    schemaVersion: string; status: string;
    run: { provenance: { kind: string } };
    tests: { attempts: { state: string } }[];
  };
  assert.equal(exitCode, 0, io.stderrText());
  assert.equal(report.schemaVersion, "surfaceloom.report/v3");
  assert.equal(report.status, "passed");
  assert.equal(report.run.provenance.kind, "native");
  assert.equal(report.tests[0]!.attempts.state, "known");
  assert.match(io.stdoutText(), /Status: passed/u);
});

test("v3 CLI returns 1 for a published business failure", async (context) => {
  const fixture = await projectFixture(context, "business-failure");
  const io = output();
  assert.equal(await runCli(["--config", fixture.config], io), 1, io.stderrText());
  const report = JSON.parse(await readFile(path.join(fixture.output, "report.json"), "utf8")) as {
    schemaVersion: string; status: string;
  };
  assert.equal(report.schemaVersion, "surfaceloom.report/v3");
  assert.equal(report.status, "failed");
  assert.equal(io.stderrText(), "");
});

test("v3 configuration and single-Case selection failures return 2 without a report", async (context) => {
  const mismatch = await projectFixture(context, "config-mismatch");
  const mismatchIO = output();
  assert.equal(await runCli(["--config", mismatch.config], mismatchIO), 2);
  assert.match(mismatchIO.stderrText(), /platform must match/u);
  await assert.rejects(access(path.join(mismatch.output, "report.json")));

  const multiple = await projectFixture(context, "pass", 2);
  const multipleIO = output();
  assert.equal(await runCli(["--config", multiple.config], multipleIO), 2);
  assert.match(multipleIO.stderrText(), /exactly one selected Case/u);
  await assert.rejects(access(path.join(multiple.output, "report.json")));
});

test("v3 publication failure returns 2, is labeled, and leaves no complete bundle", async (context) => {
  const fixture = await projectFixture(context, "publication-failure");
  const io = output();
  assert.equal(await runCli(["--config", fixture.config], io), 2);
  assert.match(io.stderrText(), /SurfaceLoom CLI publication/u);
  await assert.rejects(access(path.join(fixture.output, "complete.json")));
});

test("a v3 project rejects legacy definitions instead of importing a v2 report", async (context) => {
  const root = await temporaryDirectory(context);
  const outputDirectory = path.join(root, "report");
  const source = path.join(root, "fixture.case.mjs");
  await writeFile(source, `
import { defineCase } from ${JSON.stringify(publicEntryUrl)};
export const cases = [defineCase({ spec: ${JSON.stringify(caseSpec("legacy-in-v3"))}, run() {} })];
`);
  const config = path.join(root, "surfaceloom.config.mjs");
  await writeFile(config, configSource("pass"));
  const io = output();
  assert.equal(await runCli(["--config", config], io), 2);
  assert.match(io.stderrText(), /defineCaseV3/u);
  await assert.rejects(access(path.join(outputDirectory, "report.json")));
});

test("v3 options snapshot never assimilates hostile thenables or Promise overrides", async (context) => {
  const hostile = ["then-getter", "proxy", "promise-subclass", "promise-own-then",
    "promise-own-constructor"] as const;
  for (const behavior of hostile) {
    const fixture = await projectFixture(context, behavior);
    (globalThis as Record<string, unknown>)[fixture.counter] = 0;
    const io = output();
    assert.equal(await runCli(["--config", fixture.config], io), 2, behavior);
    assert.equal((globalThis as Record<string, unknown>)[fixture.counter], 0,
      `${behavior} executed a hostile hook`);
    delete (globalThis as Record<string, unknown>)[fixture.counter];
    await assert.rejects(access(path.join(fixture.output, "report.json")));
  }

  const genuine = await projectFixture(context, "native-promise");
  const io = output();
  assert.equal(await runCli(["--config", genuine.config], io), 0, io.stderrText());
});

test("public v2 project loader retains RunnableCase inference", async () => {
  const fixture = path.resolve("tests/fixtures/p3-093-v2-loader.type-fixture.ts");
  const typescript = path.resolve("node_modules/typescript/bin/tsc");
  await run(process.execPath, [typescript, "--noEmit", "--strict", "--skipLibCheck",
    "--exactOptionalPropertyTypes", "true", "--target", "ES2022", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", fixture], { cwd: process.cwd() });
});

async function projectFixture(context: test.TestContext,
  behavior: "pass" | "business-failure" | "config-mismatch" | "publication-failure"
    | "then-getter" | "proxy" | "promise-subclass" | "promise-own-then"
    | "promise-own-constructor" | "native-promise",
  count = 1) {
  const root = await temporaryDirectory(context);
  const outputDirectory = path.join(root, "report");
  const counter = `__surfaceloom_v3_${path.basename(root).replace(/[^A-Za-z0-9]/gu, "_")}`;
  const ids = Array.from({ length: count }, (_unused, index) => `cli-v3-${behavior}-${index + 1}`);
  await writeFile(path.join(root, "fixture.case.mjs"), caseSource(ids, behavior, outputDirectory));
  const config = path.join(root, "surfaceloom.config.mjs");
  await writeFile(config, configSource(behavior, counter));
  return { config, output: outputDirectory, counter };
}

function caseSource(ids: readonly string[], behavior: string, outputDirectory: string): string {
  const body = behavior === "business-failure"
    ? `throw new Error("business verdict failed");`
    : behavior === "publication-failure"
      ? `await mkdir(${JSON.stringify(outputDirectory)}, { recursive: true });`
      : `await context.criterion("verified", () => undefined);`;
  return `
import { mkdir } from "node:fs/promises";
import { defineCaseV3 } from ${JSON.stringify(publicEntryUrl)};
export const cases = ${JSON.stringify(ids)}.map((id) => defineCaseV3({
  spec: { ...${JSON.stringify(caseSpec("placeholder"))}, id },
  async run(context) { ${body} }
}));
`;
}

function configSource(behavior: string, counter = "__surfaceloom_v3_unused"): string {
  const result = optionsResult(behavior, counter);
  return `
import { defineExecutionPlan, defineProject } from ${JSON.stringify(publicEntryUrl)};
const backend = {
  hostId: "browser-host", capabilities: ["browser.dom.inspect"],
  async launch(_requirement, call) {
    call.beforeSubmit();
    return {
      identity: { hostId: "browser-host", sessionId: "session" },
      async invoke(_action, operation) { operation.beforeSubmit(); return null; },
      async close() { return { kind: "browserSessionClosed", hostId: "browser-host", sessionId: "session" }; }
    };
  }
};
export default defineProject({
  cases: ["fixture.case.mjs"], platform: "web", outputDir: "report",
  runner: { version: "v3", options(context) {
    const surfaces = { page: { kind: "browser", capabilities: ["browser.dom.inspect"] } };
    const configured = {
      platform: ${behavior === "config-mismatch" ? '"macos"' : "context.platform"},
      runnerHostId: "runner-host",
      run: { ...context.run, hosts: [
        { id: "runner-host", os: "linux" }, { id: "browser-host", os: "linux" }
      ] },
      surfaces: [{ kind: "browser", backend, requirement: {
        kind: "browser", surfaceId: "page", expectedHostId: "browser-host",
        capabilities: ["browser.dom.inspect"], engine: "chromium"
      } }],
      execution: {
        plan: defineExecutionPlan({ spec: context.definition.spec,
          requirements: { surfaces }, effects: [{ resource: "browser.session",
            operation: "execute", boundary: "local", securitySensitive: false,
            recovery: "unknown" }] }),
        environment: { platform: "web", host: { os: "linux" }, surfaces },
        policy: { maximumSideEffect: "writesLocal", grants: [{
          resource: "browser.session", operations: ["execute"], boundaries: ["local"],
          allowUnknownRecovery: true
        }] },
        timeoutMs: context.timeoutMs ?? 1000, cleanupTimeoutMs: 100
      },
      stagingDirectory: context.outputDirectory + ".staging",
      outputDirectory: context.outputDirectory
    };
    ${result}
  } }
});
`;
}

function optionsResult(behavior: string, counter: string): string {
  const increment = `globalThis[${JSON.stringify(counter)}] += 1; throw new Error("hook ran");`;
  if (behavior === "then-getter") {
    return `Object.defineProperty(configured, "then", { get() { ${increment} } }); return configured;`;
  }
  if (behavior === "proxy") {
    return `return new Proxy(configured, { get() { ${increment} } });`;
  }
  if (behavior === "promise-subclass") {
    return `class OptionsPromise extends Promise {}
      Object.defineProperty(OptionsPromise.prototype, "then", { get() { ${increment} } });
      return new OptionsPromise((resolve) => resolve(configured));`;
  }
  if (behavior === "promise-own-then" || behavior === "promise-own-constructor") {
    const field = behavior === "promise-own-then" ? "then" : "constructor";
    return `const promise = Promise.resolve(configured);
      Object.defineProperty(promise, ${JSON.stringify(field)}, { get() { ${increment} } });
      return promise;`;
  }
  if (behavior === "native-promise") return `return Promise.resolve(configured);`;
  return `return configured;`;
}

function caseSpec(id: string) {
  return {
    id, locale: "zh-CN", platforms: ["web"],
    suite: { id: "cli.v3", name: "命令行 v3 套件" }, name: "命令行 v3 用例",
    intent: "验证显式 v3 命令行执行。", preconditions: [],
    acceptanceCriteria: [{ id: "verified", text: "v3 执行结果正确。" }],
    sideEffect: "writesLocal",
  };
}

function output() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write: (text: string) => { stdout += text; } },
    stderr: { write: (text: string) => { stderr += text; } },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

async function temporaryDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "surfaceloom-cli-v3-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
