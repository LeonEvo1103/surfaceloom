import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { spec } from "../support.js";

type PublicApi = typeof import("../../src/index.js");

const publicEntryUrl = pathToFileURL(path.resolve("dist/index.js")).href;
const { runCli } = await import(publicEntryUrl) as PublicApi;

test("CLI loads a real public-entry project config and consumer-owned TypeScript runtime", async (context) => {
  const root = await temporaryDirectory(context);
  const cases = path.join(root, "cases");
  await mkdir(cases);
  await writeFile(path.join(cases, "configured.case.ts"), "// loaded only by the config runtime\n");
  const config = path.join(root, "surfaceloom.config.mjs");
  await writeFile(config, `
import { defineProject } from ${JSON.stringify(publicEntryUrl)};
export default defineProject({
  cases: ["cases"], platform: "web", outputDir: "report",
  typescript: { moduleFormat: "esm" }
});
export const typescriptRuntime = {
  id: "consumer.runtime.v1",
  async load(request) {
    if (request.format !== "esm" || request.language !== "typescript") throw new Error("wrong TS boundary");
    return { cases: [{
      spec: ${JSON.stringify(spec("config.typescript"))},
      run: async (context) => context.criterion("verified", () => undefined)
    }] };
  }
};
`);
  const io = output();
  const exitCode = await runCli(["--config", config, "--run-id", "config.runtime"], io);
  const report = JSON.parse(await readFile(path.join(root, "report", "report.json"), "utf8")) as {
    status: string; tests: { spec: { id: string } }[];
  };
  assert.equal(exitCode, 0);
  assert.equal(io.stderrText(), "");
  assert.equal(report.status, "passed");
  assert.deepEqual(report.tests.map((entry) => entry.spec.id), ["config.typescript"]);
});

test("CLI sources, platform, and output override project config without merging sources", async (context) => {
  const root = await temporaryDirectory(context);
  const configCase = path.join(root, "configured.case.mjs");
  const positional = path.join(root, "a.case.mjs");
  const optionSource = path.join(root, "b.case.cjs");
  await Promise.all([
    writeFile(configCase, caseModule("configured.case", "web", false)),
    writeFile(positional, caseModule("override.a", "windows", false)),
    writeFile(optionSource, caseModule("override.b", "windows", true)),
  ]);
  const config = path.join(root, "surfaceloom.config.mjs");
  await writeFile(config, `
import { defineProject } from ${JSON.stringify(publicEntryUrl)};
export default defineProject({
  cases: ["configured.case.mjs"], platform: "web", outputDir: "configured-report"
});
`);
  const overrideReport = path.join(root, "override-report");
  const io = output();
  const exitCode = await runCli([
    "--config", config, "--platform", "windows", "--output", overrideReport,
    positional, "--source", optionSource,
  ], io);
  assert.equal(exitCode, 0, io.stderrText());
  const report = JSON.parse(await readFile(path.join(overrideReport, "report.json"), "utf8")) as {
    run: { platform: string }; tests: { spec: { id: string } }[];
  };
  assert.equal(report.run.platform, "windows");
  assert.deepEqual(report.tests.map((entry) => entry.spec.id), ["override.a", "override.b"]);
  await assert.rejects(access(path.join(root, "configured-report", "report.json")));
});

test("config, TypeScript loader, and duplicate-id failures return 2 without reports", async (context) => {
  await context.test("unbranded config", async (subtest) => {
    const root = await temporaryDirectory(subtest);
    const config = path.join(root, "surfaceloom.config.mjs");
    await writeFile(config, `export default { cases: ["cases"], platform: "web", outputDir: "report" };`);
    await cliErrorWithoutReport(config, root);
  });
  await context.test("missing TypeScript runtime", async (subtest) => {
    const root = await temporaryDirectory(subtest);
    await writeFile(path.join(root, "case.case.ts"), "");
    const config = path.join(root, "surfaceloom.config.mjs");
    await writeFile(config, `
import { defineProject } from ${JSON.stringify(publicEntryUrl)};
export default defineProject({ cases: ["case.case.ts"], platform: "web",
  outputDir: "report", typescript: { moduleFormat: "esm" } });
`);
    await cliErrorWithoutReport(config, root);
  });
  await context.test("duplicate Case ids", async (subtest) => {
    const root = await temporaryDirectory(subtest);
    await Promise.all([
      writeFile(path.join(root, "a.case.mjs"), caseModule("duplicate.id", "web", false)),
      writeFile(path.join(root, "b.case.mjs"), caseModule("duplicate.id", "web", false)),
    ]);
    const config = path.join(root, "surfaceloom.config.mjs");
    await writeFile(config, `
import { defineProject } from ${JSON.stringify(publicEntryUrl)};
export default defineProject({ cases: ["."], platform: "web", outputDir: "report" });
`);
    await cliErrorWithoutReport(config, root);
  });
});

test("config mode still requires a final platform and output", async (context) => {
  const root = await temporaryDirectory(context);
  await writeFile(path.join(root, "case.case.mjs"), caseModule("required.values", "web", false));
  const missingPlatform = path.join(root, "missing-platform.config.mjs");
  const missingOutput = path.join(root, "missing-output.config.mjs");
  await Promise.all([
    writeFile(missingPlatform, `
import { defineProject } from ${JSON.stringify(publicEntryUrl)};
export default defineProject({ cases: ["case.case.mjs"], outputDir: "report-a" });
`),
    writeFile(missingOutput, `
import { defineProject } from ${JSON.stringify(publicEntryUrl)};
export default defineProject({ cases: ["case.case.mjs"], platform: "web" });
`),
  ]);
  for (const config of [missingPlatform, missingOutput]) {
    const io = output();
    assert.equal(await runCli(["--config", config], io), 2);
    assert.match(io.stderrText(), /required unless supplied by --config/u);
  }
  await assert.rejects(access(path.join(root, "report-a", "report.json")));
});

test("config mode rejects an output ancestor symlink without creating an external report", async (context) => {
  const root = await temporaryDirectory(context);
  const external = await temporaryDirectory(context);
  await writeFile(path.join(root, "case.case.mjs"), caseModule("symlink.output", "web", false));
  await symlink(external, path.join(root, "node_modules"), "dir");
  const config = path.join(root, "surfaceloom.config.mjs");
  await writeFile(config, `
import { defineProject } from ${JSON.stringify(publicEntryUrl)};
export default defineProject({ cases: ["case.case.mjs"], platform: "web",
  outputDir: "node_modules/report" });
`);
  const io = output();
  assert.equal(await runCli(["--config", config], io), 2);
  assert.match(io.stderrText(), /symbolic-link ancestor/u);
  await assert.rejects(access(path.join(external, "report", "report.json")));
});

test("legacy CLI mode remains compatible without --config", async (context) => {
  const root = await temporaryDirectory(context);
  const source = path.join(root, "legacy.case.mjs");
  const reportDir = path.join(root, "legacy-report");
  await writeFile(source, caseModule("legacy.cli", "web", false));
  const io = output();
  const exitCode = await runCli(["--platform", "web", "--output", reportDir, source], io);
  assert.equal(exitCode, 0, io.stderrText());
  const report = JSON.parse(await readFile(path.join(reportDir, "report.json"), "utf8")) as {
    tests: { spec: { id: string } }[];
  };
  assert.deepEqual(report.tests.map((entry) => entry.spec.id), ["legacy.cli"]);
});

async function cliErrorWithoutReport(config: string, root: string): Promise<void> {
  const io = output();
  assert.equal(await runCli(["--config", config], io), 2);
  assert.match(io.stderrText(), /SurfaceLoom CLI/u);
  await assert.rejects(access(path.join(root, "report", "report.json")));
}

function caseModule(id: string, platform: "web" | "windows", commonjs: boolean): string {
  const value = spec(id) as ReturnType<typeof spec>;
  const payload = JSON.stringify([{ spec: { ...value, platforms: [platform] } }]);
  return commonjs
    ? `module.exports = ${payload}.map((entry) => ({ ...entry, async run(context) { await context.criterion("verified", () => undefined); } }));`
    : `export const cases = ${payload}.map((entry) => ({ ...entry, async run(context) { await context.criterion("verified", () => undefined); } }));`;
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
  const directory = await mkdtemp(path.join(tmpdir(), "surfaceloom-cli-project-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
