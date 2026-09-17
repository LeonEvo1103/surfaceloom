import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultEvidencePolicy, validateReportV3Input } from "@surfaceloom/reporter";

import {
  EvidenceSubmissionCollector,
  RunnerRequiredEvidenceAuthority,
  RunnerExecutionAuthority,
  SurfaceAcquisitionRegistry,
  type ExecutionScope,
} from "../src/evidence/index.js";
import {
  createCaseReportV3,
  createReportV3Attempt,
  createSurfaceCatalogV3,
  materializeEvidenceV3,
} from "../src/report/v3/index.js";
import { spec as baseSpec } from "./support.js";

const capturedAt = "2026-09-17T01:02:03.000Z";

test("runner owns contiguous attempt ordinals and the final attempt selection", () => {
  const authority = new RunnerExecutionAuthority({ reportRunId: "run-1", runnerHostId: "runner-1" });
  assert.throws(() => authority.issue({ caseExecutionId: "execution-1",
    attemptId: "attempt-2", ordinal: 2 }), /contiguous/);
  const first = authority.issue({ caseExecutionId: "execution-1", attemptId: "attempt-1", ordinal: 1 });
  const second = authority.issue({ caseExecutionId: "execution-1", attemptId: "attempt-2", ordinal: 2 });
  assert.throws(() => authority.finalize("execution-1", first.attemptId), /highest/);
  assert.deepEqual(authority.finalize("execution-1", second.attemptId), {
    caseExecutionId: "execution-1", finalAttemptId: "attempt-2", ordinal: 2,
  });
  assert.throws(() => authority.issue({ caseExecutionId: "execution-1",
    attemptId: "attempt-3", ordinal: 3 }), /finalized/);
  assert.throws(() => new RunnerExecutionAuthority({
    reportRunId: "/Users/alice/run", runnerHostId: "runner-1",
  }), /stable identifier/);
});

test("two executions and two actual surfaces stay isolated through report/v3 adaptation", async (context) => {
  const root = await temporary(context);
  const authority = new RunnerExecutionAuthority({ reportRunId: "run-1", runnerHostId: "runner-1" });
  const firstScope = authority.issue({ caseExecutionId: "execution-1", attemptId: "attempt-1", ordinal: 1 });
  const otherScope = authority.issue({ caseExecutionId: "execution-2", attemptId: "attempt-1", ordinal: 1 });
  const first = collector(firstScope, "shared-artifact");
  const other = collector(otherScope, "shared-artifact");
  assert.equal(first.context.caseExecutionId, "execution-1");
  assert.equal(other.context.caseExecutionId, "execution-2");
  assert.notDeepEqual(first.context.nodes, other.context.nodes);

  const registry = new SurfaceAcquisitionRegistry(firstScope);
  const provider = registry.authorizeProvider("mixed-provider");
  provider.submit(surface(firstScope, "page", "browser", "browser-host", "web"));
  provider.submit(surface(firstScope, "native-app", "desktop", "native-host", "windows"));
  const surfaces = registry.seal();
  assert.deepEqual(surfaces.acquisitions.map((item) => item.surfaceId), ["native-app", "page"]);
  assert.throws(() => provider.submit(surface(firstScope, "late", "browser", "browser-host", "web")),
    /Late surface/);

  const materialized = await materializeEvidenceV3(first, path.join(root, "staging"));
  const requiredEvidencePolicy = new RunnerRequiredEvidenceAuthority().issue(firstScope, [
    { artifactId: "shared-artifact", requireComplete: true },
  ]);
  const result = {
    status: "failed" as const,
    startedAt: capturedAt,
    durationMs: 5,
    steps: [{ id: "verified", title: "验证结果", status: "failed" as const, durationMs: 5,
      criterionIds: ["verified"] }],
    error: { category: "assertion", message: "Native criterion failed." },
  };
  const adapted = createReportV3Attempt({ scope: firstScope, surfaces, evidence: first,
    materializedEvidence: materialized, requiredEvidencePolicy,
    evidencePolicy: defaultEvidencePolicy, result });
  assert.equal(adapted.attempt.result.status, "failed");
  assert.deepEqual(adapted.attempt.executionPlatforms, ["windows", "web"]);
  assert.deepEqual(adapted.attempt.surfaceIds, { state: "known", value: ["native-app", "page"] });
  const final = authority.finalize("execution-1", "attempt-1");
  const spec = { ...baseSpec("case.mixed"), platforms: ["web", "windows"] as const };
  const reportCase = createCaseReportV3({ spec, attempts: [adapted], finalAttempt: final });
  const surfaceCatalog = createSurfaceCatalogV3([surfaces]);
  assert.doesNotThrow(() => validateReportV3Input({
    run: {
      id: "run-1", title: "Mixed surfaces", startedAt: capturedAt,
      finishedAt: "2026-09-17T01:02:04.000Z", app: { id: "fixture", name: "Fixture" },
      provenance: { kind: "native" },
      hosts: { state: "known", value: [
        { id: "runner-1", os: "linux" }, { id: "browser-host", os: "linux" },
        { id: "native-host", os: "windows" },
      ] },
      surfaces: surfaceCatalog,
    },
    tests: [reportCase],
  }));
  const native = JSON.parse(await readFile(materialized.artifacts[0]!.sourcePath!, "utf8")) as {
    content: { outcome: string };
  };
  assert.equal(native.content.outcome, "failed");
  assert.equal(reportCase.attempts.state, "known");
  assert.equal(reportCase.attempts.state === "known"
    ? reportCase.attempts.items[0]!.result.status : "", "failed");
});

test("opaque runner capabilities reject forged snapshots, attempts, final selections and cross-run mixing",
  async (context) => {
    const root = await temporary(context);
    const authority = new RunnerExecutionAuthority({ reportRunId: "run-a", runnerHostId: "runner" });
    const scope = authority.issue({ caseExecutionId: "execution", attemptId: "attempt-1", ordinal: 1 });
    const evidence = collector(scope, "required-a");
    await assert.rejects(materializeEvidenceV3({ ...evidence }, path.join(root, "forged-evidence")),
      /not sealed/);
    const registry = new SurfaceAcquisitionRegistry(scope);
    registry.authorizeProvider("provider").submit(surface(scope, "page-a", "browser", "host", "web"));
    const surfaces = registry.seal();
    assert.throws(() => createSurfaceCatalogV3([{ ...surfaces }]), /not sealed/);
    const materialized = await materializeEvidenceV3(evidence, path.join(root, "real-evidence"));
    const requiredEvidencePolicy = new RunnerRequiredEvidenceAuthority().issue(scope, [
      { artifactId: "required-a", requireComplete: true },
    ]);
    const adapted = createReportV3Attempt({ scope, surfaces, evidence, materializedEvidence: materialized,
      requiredEvidencePolicy, evidencePolicy: defaultEvidencePolicy, result: passingResult() });
    const final = authority.finalize(scope.caseExecutionId, scope.attemptId);
    assert.throws(() => createCaseReportV3({ spec: baseSpec("opaque.forged-attempt"),
      attempts: [{ ...adapted }], finalAttempt: final }), /not runner-adapted/);
    assert.throws(() => createCaseReportV3({ spec: baseSpec("opaque.forged-final"),
      attempts: [adapted], finalAttempt: { ...final } }), /not runner-issued/);

    const otherAuthority = new RunnerExecutionAuthority({ reportRunId: "run-b", runnerHostId: "runner" });
    const otherScope = otherAuthority.issue({ caseExecutionId: "execution", attemptId: "attempt-b", ordinal: 1 });
    const otherEvidence = collector(otherScope, "required-b");
    const otherRegistry = new SurfaceAcquisitionRegistry(otherScope);
    otherRegistry.authorizeProvider("provider").submit(
      surface(otherScope, "page-b", "browser", "host", "web"));
    const otherMaterialized = await materializeEvidenceV3(otherEvidence, path.join(root, "other-evidence"));
    const otherAdapted = createReportV3Attempt({ scope: otherScope, surfaces: otherRegistry.seal(),
      evidence: otherEvidence, materializedEvidence: otherMaterialized,
      requiredEvidencePolicy: new RunnerRequiredEvidenceAuthority().issue(otherScope, [
        { artifactId: "required-b", requireComplete: true },
      ]), evidencePolicy: defaultEvidencePolicy, result: passingResult() });
    const otherFinal = otherAuthority.finalize(otherScope.caseExecutionId, otherScope.attemptId);
    assert.throws(() => createCaseReportV3({ spec: baseSpec("opaque.cross-run"),
      attempts: [adapted, otherAdapted], finalAttempt: otherFinal }), /same runner authority/);
  });

function collector(scope: ExecutionScope, artifactId: string) {
  const instance = new EvidenceSubmissionCollector(scope);
  const source = { kind: "probe" as const, producerId: "native-provider", sourceRecordId: "native-1" };
  const artifact = { kind: "artifact" as const, caseExecutionId: scope.caseExecutionId,
    attemptId: scope.attemptId, artifactId };
  instance.submit({ id: "native-submission", scope, source, artifact,
    nodes: [{ ...artifact, source }], relations: [{ id: "native-artifact-link", relation: "contains",
      from: { kind: "attempt", caseExecutionId: scope.caseExecutionId, attemptId: scope.attemptId },
      to: artifact, source }], completeness: { state: "complete" }, capturedAt,
    content: { kind: "nativeOperation", runId: "agent-run", callId: "call-1",
      operationId: "operation-1", hostInstanceId: "native-host-instance", sessionId: "session-1",
      targetIdentity: "target-1", resource: "native.ui.invoke", outcome: "failed",
      detail: { status: "failed", verdict: "passed" } } });
  const traceSource = { kind: "trace-importer" as const, producerId: "trace-provider",
    sourceRecordId: "trace-1" };
  const traceArtifact = { kind: "artifact" as const, caseExecutionId: scope.caseExecutionId,
    attemptId: scope.attemptId, artifactId: "trace-artifact" };
  instance.submit({ id: "trace-submission", scope, source: traceSource, artifact: traceArtifact,
    nodes: [{ ...traceArtifact, source: traceSource }], relations: [{ id: "trace-artifact-link",
      relation: "contains", from: { kind: "attempt", caseExecutionId: scope.caseExecutionId,
        attemptId: scope.attemptId }, to: traceArtifact, source: traceSource }],
    completeness: { state: "complete" }, capturedAt, correlationId: "diagnostic-group",
    content: { kind: "trace", schemaVersion: "trace/v1",
      trace: { status: "passed", verdict: "passed", observedAt: capturedAt } } });
  return instance.seal({ capturedAt });
}

function surface(scope: ExecutionScope, surfaceId: string, kind: "browser" | "desktop",
  hostId: string, executionPlatform: "web" | "windows") {
  return { scope, surfaceId, kind, hostId, executionPlatform,
    effectiveCapabilities: [kind === "browser" ? "browser.dom" : "ui.invoke"],
    ownership: "owned" as const, cleanup: { status: "confirmed" as const, resource: surfaceId } };
}

async function temporary(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "p3-055-evidence-v3-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function passingResult() {
  return { status: "passed" as const, startedAt: capturedAt, durationMs: 1, steps: [] };
}
