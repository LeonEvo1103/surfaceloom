import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EvidenceSubmissionCollector,
  RunnerExecutionAuthority,
  type EvidenceSubmission,
  type ExecutionScope,
} from "../../src/evidence/index.js";
import { materializeEvidenceV3 } from "../../src/report/v3/index.js";

const capturedAt = "2026-09-17T01:02:03.000Z";
const secret = ["sk", "synthetic", "title", "fixture", "value"].join("-");

test("materialized evidence titles distinguish kind, identifiers and source without values",
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "evidence-title-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const scope = new RunnerExecutionAuthority({ reportRunId: "run-1", runnerHostId: "runner-1" })
      .issue({ caseExecutionId: "execution-1", attemptId: "attempt-1", ordinal: 1 });
    const collector = new EvidenceSubmissionCollector(scope);
    collector.submit(submission(scope, "ledger-probe", { kind: "probe", probeId: "ledger-probe",
      resource: "agent.ledger", outcome: "observed", value: { apiToken: secret, count: 3 } }));
    collector.submit(submission(scope, "ui-probe", { kind: "probe", probeId: "ui-probe",
      resource: "agent.ui", outcome: "unknown" }));
    collector.submit(submission(scope, "agent-trace", { kind: "trace",
      schemaVersion: "agent-loop/v1", trace: { prompt: secret } }));
    collector.submit(submission(scope, "native-op", { kind: "nativeOperation", runId: null,
      callId: null, operationId: "invoke-save", hostInstanceId: "host-1", sessionId: "session-1",
      targetIdentity: "target-1", resource: "native.ui.invoke", outcome: "failed",
      detail: { note: secret } }));
    const materialized = await materializeEvidenceV3(collector.seal({ capturedAt }), root);
    const titles = materialized.artifacts.map((artifact) => artifact.title);

    assert.deepEqual(titles, [
      "Probe ledger-probe · resource agent.ledger · observed · source probe:probe-1",
      "Probe ui-probe · resource agent.ui · unknown · source probe:probe-1",
      "Trace (agent-loop/v1) · source probe:probe-1",
      "Native operation invoke-save · resource native.ui.invoke · failed · source probe:probe-1",
      "Evidence graph",
    ]);
    assert.equal(new Set(titles).size, titles.length);
    for (const title of titles) {
      assert.ok(!title.includes(secret));
      assert.doesNotMatch(title, /count|apiToken|prompt|note/u);
    }
  });

function submission(scope: ExecutionScope, id: string, content: unknown): EvidenceSubmission {
  const source = { kind: "probe" as const, producerId: "probe-1", sourceRecordId: id };
  const artifact = { kind: "artifact" as const, caseExecutionId: scope.caseExecutionId,
    attemptId: scope.attemptId, artifactId: id };
  return { id, scope, source, artifact, nodes: [{ ...artifact, source }],
    relations: [{ id: `link-${id}`, relation: "contains", from: {
      kind: "attempt", caseExecutionId: scope.caseExecutionId, attemptId: scope.attemptId,
    }, to: artifact, source }], completeness: { state: "complete" }, capturedAt, content };
}
