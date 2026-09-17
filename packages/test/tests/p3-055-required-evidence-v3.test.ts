import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultEvidencePolicy } from "@surfaceloom/reporter";

import {
  EvidenceSubmissionCollector,
  RunnerExecutionAuthority,
  RunnerRequiredEvidenceAuthority,
  SurfaceAcquisitionRegistry,
  mergeRequiredEvidenceFailures,
  validateRequiredEvidence,
  type EvidenceCollectionSnapshot,
  type ExecutionScope,
} from "../src/evidence/index.js";
import { createReportV3Attempt } from "../src/report/v3/adapter.js";
import {
  assertMaterializedEvidenceV3,
  materializeEvidenceV3,
} from "../src/report/v3/materialize.js";
import { requiredReportArtifactsV3 } from "../src/report/v3/required-artifacts.js";

const capturedAt = "2026-09-17T01:02:03.000Z";

test("required missing and incomplete evidence fail with structured collection failures", async (context) => {
  const scope = oneScope("missing-incomplete");
  const evidence = collect(scope, [
    { id: "incomplete", complete: false, kind: "probe" },
  ]);
  const policy = new RunnerRequiredEvidenceAuthority().issue(scope, [
    { artifactId: "missing", requireComplete: true },
    { artifactId: "incomplete", requireComplete: true },
  ]);
  const validation = validateRequiredEvidence(policy, evidence,
    await materialize(context, evidence, "missing-incomplete"), defaultEvidencePolicy, "passed");
  assert.equal(validation.status, "failed");
  assert.deepEqual(validation.failures.map((item) => item.code), [
    "requiredMissing", "requiredIncomplete",
  ]);
  assert.ok(validation.failures.every((item) => Object.isFrozen(item)));
});

test("Reporter retention removal fails closed for a genuine materialization receipt", async (context) => {
  const scope = oneScope("materialized-retention");
  const evidence = collect(scope, [
    { id: "required-log", complete: true, kind: "probe" },
    { id: "required-trace", complete: true, kind: "trace" },
  ]);
  const policy = new RunnerRequiredEvidenceAuthority().issue(scope, [
    { artifactId: "required-log", requireComplete: true },
    { artifactId: "required-trace", requireComplete: true },
  ]);
  const validation = validateRequiredEvidence(policy, evidence,
    await materialize(context, evidence, "retention"),
    { ...defaultEvidencePolicy, trace: "off" }, "passed");
  assert.equal(validation.status, "failed");
  assert.deepEqual(validation.failures.map((item) => item.code), ["retentionRemoved"]);
});

test("optional incomplete evidence does not block a complete required artifact", async (context) => {
  const scope = oneScope("optional");
  const evidence = collect(scope, [
    { id: "required", complete: true, kind: "probe" },
    { id: "optional", complete: false, kind: "probe" },
  ]);
  const policy = new RunnerRequiredEvidenceAuthority().issue(scope, [
    { artifactId: "required", requireComplete: true },
  ]);
  const validation = validateRequiredEvidence(policy, evidence,
    await materialize(context, evidence, "optional"), defaultEvidencePolicy, "passed");
  assert.deepEqual(validation, { status: "passed", failures: [] });
});

test("report/v3 adaptation rejects mutated staging without rewriting verdict", async (context) => {
  const scope = oneScope("adapter");
  const evidence = collect(scope, [{ id: "required", complete: true, kind: "probe" }]);
  const requiredEvidencePolicy = new RunnerRequiredEvidenceAuthority().issue(scope, [
    { artifactId: "required", requireComplete: true },
  ]);
  const registry = new SurfaceAcquisitionRegistry(scope);
  registry.authorizeProvider("provider").submit({ scope, surfaceId: "page", kind: "browser",
    hostId: "host-1", executionPlatform: "web", effectiveCapabilities: [],
    ownership: "borrowed", cleanup: { status: "notRequired", resource: "page" } });
  const result = { status: "failed" as const, startedAt: capturedAt, durationMs: 1, steps: [],
    error: { category: "body", message: "body failed first" } };
  const receipt = await materialize(context, evidence, "adapter");
  await writeFile(receipt.artifacts[0]!.sourcePath!, "replacement");
  assert.throws(() => createReportV3Attempt({ scope, surfaces: registry.seal(), evidence,
    materializedEvidence: receipt, requiredEvidencePolicy,
    evidencePolicy: defaultEvidencePolicy, result }), /bytes changed/);
  assert.equal(result.status, "failed");
  assert.equal(result.error.message, "body failed first");
});

test("evidence failure merge preserves an existing body failure as the primary cause", async (context) => {
  const scope = oneScope("merge");
  const evidence = collect(scope, []);
  const policy = new RunnerRequiredEvidenceAuthority().issue(scope, [
    { artifactId: "required", requireComplete: true },
  ]);
  const validation = validateRequiredEvidence(policy, evidence,
    await materialize(context, evidence, "merge"),
    defaultEvidencePolicy, "failed");
  const bodyFailure = Object.freeze({ phase: "body", message: "original failure" });
  const merged = mergeRequiredEvidenceFailures(bodyFailure, validation);
  assert.equal(merged.primaryFailure, bodyFailure);
  assert.equal(merged.failures[0], bodyFailure);
  assert.equal(merged.evidenceFailures[0]!.code, "requiredMissing");
});

test("materialization receipt is bound to its exact snapshot and projects integrity refs", async (context) => {
  const scope = oneScope("receipt");
  const evidence = collect(scope, [{ id: "required", complete: true, kind: "probe" }]);
  const receipt = await materialize(context, evidence, "receipt");
  const policy = new RunnerRequiredEvidenceAuthority().issue(scope, [
    { artifactId: "required", requireComplete: true },
  ]);
  assert.doesNotThrow(() => assertMaterializedEvidenceV3(receipt, evidence));
  assert.throws(() => assertMaterializedEvidenceV3({ ...receipt }, evidence), /not runner-issued/);
  const other = collect(oneScope("other-receipt"), []);
  assert.throws(() => assertMaterializedEvidenceV3(receipt, other), /does not belong/);
  const refs = requiredReportArtifactsV3("case.receipt", policy, receipt, evidence);
  assert.equal(refs[0]?.attemptId, scope.attemptId);
  assert.equal(refs[0]?.expectedSizeBytes > 0, true);
  assert.match(refs[0]?.expectedSha256 ?? "", /^[a-f0-9]{64}$/u);
});

function oneScope(suffix: string): ExecutionScope {
  return new RunnerExecutionAuthority({ reportRunId: "run-1", runnerHostId: "runner-1" })
    .issue({ caseExecutionId: `execution-${suffix}`, attemptId: "attempt-1", ordinal: 1 });
}

function collect(scope: ExecutionScope, items: readonly {
  id: string; complete: boolean; kind: "probe" | "trace";
}[]): EvidenceCollectionSnapshot {
  const collector = new EvidenceSubmissionCollector(scope);
  for (const item of items) {
    const source = { kind: "probe" as const, producerId: "producer-1",
      sourceRecordId: `source-${item.id}` };
    const ref = { kind: "artifact" as const, caseExecutionId: scope.caseExecutionId,
      attemptId: scope.attemptId, artifactId: item.id };
    collector.submit({ id: `submission-${item.id}`, scope, source, artifact: ref,
      nodes: [{ ...ref, source }], relations: [{ id: `link-${item.id}`, relation: "contains",
        from: { kind: "attempt", caseExecutionId: scope.caseExecutionId,
          attemptId: scope.attemptId }, to: ref, source }], capturedAt,
      completeness: item.complete ? { state: "complete" }
        : { state: "incomplete", reasons: ["producerDeclaredIncomplete"] },
      content: item.kind === "trace"
        ? { kind: "trace", schemaVersion: "trace/v1", trace: { event: item.id } }
        : { kind: "probe", probeId: item.id, resource: "fixture.read", outcome: "observed" } });
  }
  return collector.seal({ capturedAt });
}

async function materialize(context: test.TestContext, evidence: EvidenceCollectionSnapshot,
  label: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `p3-055-${label}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  return materializeEvidenceV3(evidence, root);
}
