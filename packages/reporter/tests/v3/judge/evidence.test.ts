import assert from "node:assert/strict";
import test from "node:test";

import { createJudgeEvidenceV3 } from "../../../src/v3/judge/index.js";

function input() {
  return {
    artifactId: "judge.route.result",
    capturedAt: "2026-09-20T01:00:00.000Z",
    sourcePath: "/tmp/judge.route.result.json",
    binding: { reportRunId: "run-1", caseExecutionId: "case-1", attemptId: "attempt-1",
      judgeCriterionId: "route", acceptanceCriterionId: "route-correct" },
    correlationId: "judge.case-1.attempt-1.route",
    evidence: [{ evidenceId: "judge.route.evidence.1", artifactId: "page-state" }],
    outcome: { status: "classified", label: "sign-in", confidence: 0.9 },
    decision: { status: "passed" as const, reason: "Judge classified sign-in." },
  };
}

test("creates structured Reporter v3 Judge evidence with runner-owned correlation", () => {
  const output = createJudgeEvidenceV3(input());
  assert.equal(output.record.schemaVersion, "surfaceloom.judge-evidence/v1");
  assert.equal(output.record.binding.attemptId, "attempt-1");
  assert.equal(output.artifact.id, "judge.route.result");
  assert.deepEqual(output.artifact.relatedArtifactIds, ["page-state"]);
});

test("rejects getters and Proxy input without executing hostile code", () => {
  let reads = 0;
  const getter = input();
  Object.defineProperty(getter, "correlationId", { enumerable: true,
    get() { reads += 1; return "forged"; } });
  assert.throws(() => createJudgeEvidenceV3(getter), /accessor/);
  assert.equal(reads, 0);

  let traps = 0;
  const proxy = new Proxy(input(), { ownKeys() { traps += 1; throw new Error("executed"); } });
  assert.throws(() => createJudgeEvidenceV3(proxy), /getter-free/);
  assert.equal(traps, 0);
});

test("rejects duplicate correlation targets", () => {
  const duplicate = input();
  duplicate.evidence.push({ ...duplicate.evidence[0]! });
  assert.throws(() => createJudgeEvidenceV3(duplicate), /Duplicate|unique/);
});
