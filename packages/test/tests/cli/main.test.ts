import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../../src/cli/index.js";

test("CLI discovers multiple Cases, writes one canonical report, and returns test status", async (context) => {
  const root = await temporaryDirectory(context);
  const source = path.join(root, "fixture.case.mjs");
  const output = path.join(root, "report");
  await writeFile(source, `
export const cases = [
  {
    spec: {
      id: "cli.pass", locale: "zh-CN", platforms: ["web"],
      suite: { id: "cli.suite", name: "命令行套件" }, name: "通过用例",
      intent: "验证命令行执行多个用例。", preconditions: [],
      acceptanceCriteria: [{ id: "verified", text: "结果通过。" }], sideEffect: "readOnly"
    },
    run: async (context) => context.criterion("verified", () => undefined)
  },
  {
    spec: {
      id: "cli.fail", locale: "zh-CN", platforms: ["web"],
      suite: { id: "cli.suite", name: "命令行套件" }, name: "失败用例",
      intent: "验证失败退出码。", preconditions: [],
      acceptanceCriteria: [{ id: "verified", text: "结果通过。" }], sideEffect: "readOnly"
    },
    run: () => { throw new Error("fixture failure"); }
  }
];
`);
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli([
    "--platform", "web", "--output", output, "--run-id", "cli.contract", source,
  ], {
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8")) as {
    status: string; tests: { spec: { id: string }, result: { status: string } }[];
  };
  assert.equal(exitCode, 1);
  assert.equal(stderr, "");
  assert.match(stdout, /passed=1; failed=1/);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.tests.map((item) => item.spec.id), ["cli.pass", "cli.fail"]);
});

test("CLI returns a distinct invocation error without creating a report", async () => {
  let stderr = "";
  const exitCode = await runCli(["--platform", "invalid"], {
    stdout: { write: () => undefined },
    stderr: { write: (text) => { stderr += text; } },
  });
  assert.equal(exitCode, 2);
  assert.match(stderr, /Unknown platform/);
});

async function temporaryDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "surfaceloom-test-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
