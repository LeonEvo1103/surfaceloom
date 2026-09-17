import assert from "node:assert/strict";
import test from "node:test";

import { defaultEvidencePolicy, type TestRunReport } from "../../src/index.js";
import { importReportV2 } from "../../src/v3/index.js";

function v2Report(): TestRunReport {
  const startedAt = "2026-09-16T01:00:00.000Z";
  return {
    schemaVersion: "surfaceloom.report/v2",
    run: {
      id: "legacy-run", title: "Legacy report", platform: "web", startedAt,
      finishedAt: "2026-09-16T01:00:01.000Z",
      app: { id: "legacy.app", name: "Legacy App" },
    },
    status: "passed",
    summary: {
      discovered: 1, executed: 1, passed: 1, failed: 0, timedOut: 0, skipped: 0,
      unsupported: 0,
      evidence: { captured: 0, captureFailed: 0, unsupported: 0, notRequested: 0 },
    },
    evidencePolicy: defaultEvidencePolicy,
    tests: [{
      spec: {
        id: "legacy-case", locale: "zh-CN", platforms: ["web"],
        suite: { id: "legacy.suite", name: "旧报告" }, name: "旧版通过用例",
        intent: "验证旧报告保守迁移。", preconditions: [],
        acceptanceCriteria: [{ id: "verified", text: "旧结果被完整保留。" }],
        sideEffect: "readOnly",
      },
      result: {
        status: "passed", startedAt, durationMs: 1,
        steps: [{ id: "verified", title: "确认旧结果", status: "passed", durationMs: 1,
          criterionIds: ["verified"] }],
        artifacts: [],
      },
    }],
  };
}

test("v2 import preserves source platform while keeping host, surfaces, and attempts unknown", () => {
  const imported = importReportV2(v2Report());
  assert.equal(imported.schemaVersion, "surfaceloom.report/v3");
  assert.deepEqual(imported.run.provenance, {
    kind: "imported-v2",
    sourceSchemaVersion: "surfaceloom.report/v2",
    sourcePlatform: "web",
    limitations: ["hostNotRecorded", "surfacesNotRecorded", "attemptsNotRecorded"],
  });
  assert.equal(imported.run.hosts.state, "unknown");
  assert.equal(imported.run.surfaces.state, "unknown");
  assert.equal(imported.tests[0]!.attempts.state, "unknown");
  assert.equal(imported.tests[0]!.attempts.result.status, "passed");
  assert.equal(imported.summary.attempts, 0);
  assert.equal(imported.summary.casesWithUnknownAttempts, 1);
});

test("v2 import rejects inconsistent authoritative status instead of normalizing it", () => {
  const report = v2Report();
  const invalid = { ...report, status: "failed" as const };
  assert.throws(() => importReportV2(invalid), /summary or status is inconsistent/);
});

test("v2 import cannot be mislabeled with known migrated context", () => {
  const imported = importReportV2(v2Report());
  assert.equal("platform" in imported.run, false);
  assert.equal("value" in imported.run.hosts, false);
  assert.equal("value" in imported.run.surfaces, false);
  assert.equal("items" in imported.tests[0]!.attempts, false);
});

test("v2 import rejects accessors before they can change validated facts", () => {
  const report = v2Report();
  let reads = 0;
  Object.defineProperty(report.run, "id", {
    enumerable: true,
    get() {
      reads += 1;
      return reads < 2 ? "safe-run" : "/Users/alice/AWS_SECRET_ACCESS_KEY=LEAK";
    },
  });
  assert.throws(() => importReportV2(report), /enumerable data field/);
  assert.equal(reads, 0);
});
