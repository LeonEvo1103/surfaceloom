import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createSuiteReport, writeSuiteReport } from "../../src/report/index.js";
import { spec } from "../support.js";

test("suite report preserves Case order and derives incomplete exit semantics", () => {
  const startedAt = "2026-09-16T00:00:00.000Z";
  const report = createSuiteReport({
    id: "suite.contract",
    title: "Suite contract",
    platform: "web",
    startedAt,
    finishedAt: "2026-09-16T00:00:01.000Z",
    app: { id: "fixture.app", name: "Fixture App" },
  }, [{
    spec: spec("case.passed"),
    result: { status: "passed", startedAt, durationMs: 1, steps: [{
      id: "criterion.verified", title: "验证结果", status: "passed", durationMs: 1,
      criterionIds: ["verified"],
    }] },
  }, {
    spec: { ...spec("case.unsupported"), platforms: ["web"] },
    result: { status: "unsupported", startedAt, durationMs: 0, steps: [],
      reason: "当前环境缺少所需能力。" },
  }]);
  assert.deepEqual(report.input.tests.map((item) => item.spec.id), ["case.passed", "case.unsupported"]);
  assert.equal(report.summary.discovered, 2);
  assert.equal(report.summary.executed, 2);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.summary.unsupported, 1);
  assert.equal(report.status, "incomplete");
  assert.equal(report.exitCode, 1);
  assert.ok(Object.isFrozen(report));
});

test("suite writer emits Reporter canonical report.json without changing status", async (context) => {
  const directory = await temporaryDirectory(context);
  const startedAt = "2026-09-16T00:00:00.000Z";
  const snapshot = createSuiteReport({
    id: "suite.write",
    title: "Suite write",
    platform: "web",
    startedAt,
    finishedAt: "2026-09-16T00:00:01.000Z",
    app: { id: "fixture.app", name: "Fixture App" },
  }, [{ spec: spec("case.write"), result: {
    status: "passed", startedAt, durationMs: 1,
    steps: [{ id: "verified", title: "验证结果", status: "passed", durationMs: 1,
      criterionIds: ["verified"] }],
  } }]);
  const written = await writeSuiteReport(snapshot, `${directory}/report`);
  const json = JSON.parse(await readFile(written.bundle.reportPath, "utf8")) as {
    schemaVersion: string; status: string; tests: { spec: { id: string } }[];
  };
  assert.equal(json.schemaVersion, "surfaceloom.report/v2");
  assert.equal(json.status, "passed");
  assert.equal(json.tests[0]?.spec.id, "case.write");
  assert.equal(written.exitCode, 0);
});

async function temporaryDirectory(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "surfaceloom-test-report-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
