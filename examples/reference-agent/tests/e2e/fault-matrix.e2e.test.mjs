import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderAIReviewV3, renderHTMLReportV3 } from "@surfaceloom/reporter";
import { resolveBrowserLaunchOptions } from "../../adapter/browser-launch.mjs";
import {
  browserHostId,
  browserSurfaceId,
  evidenceArtifactId,
  faultMatrixCases,
  runnerHostId,
} from "../../fault-matrix/matrix.mjs";
import { runFaultMatrixCase } from "../../fault-matrix/run.mjs";
test("P3-088 eight-Case live fault matrix preserves 2 pass and 6 fail reports", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sl-p3-088-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launchOptions = await resolveBrowserLaunchOptions();
  const results = [];
  for (const entry of faultMatrixCases) {
    const result = await runFaultMatrixCase(entry,
      { outputRoot: path.join(root, entry.key), launchOptions });
    await verifyReport(entry, result);
    results.push(result.bundle.report.tests[0].attempts.items[0].result.status);
  }
  assert.deepEqual({ passed: results.filter((status) => status === "passed").length,
    failed: results.filter((status) => status === "failed").length }, { passed: 2, failed: 6 });
});
test("expected red rejects an unrelated failure thrown after real browser close", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sl-p3-088-close-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputRoot = path.join(root, "case");
  let realCloseCompleted = false;
  const wrapBackend = (backend) => Object.freeze({
    hostId: backend.hostId,
    capabilities: backend.capabilities,
    launch: async (...args) => {
      const session = await backend.launch(...args);
      return Object.freeze({
        identity: session.identity,
        invoke: (...invokeArgs) => session.invoke(...invokeArgs),
        close: async () => {
          await session.close();
          realCloseCompleted = true;
          throw new Error("AUDIT unrelated browser close receipt failure");
        },
      });
    },
  });
  await assert.rejects(runFaultMatrixCase(faultMatrixCases[0], {
    outputRoot,
    launchOptions: await resolveBrowserLaunchOptions(),
    wrapBackend,
  }), (error) => {
    assert.equal(realCloseCompleted, true, "the injected error ran before real browser close");
    assert.match(error.message, /infrastructure is unhealthy/u);
    return true;
  });
  const report = JSON.parse(await readFile(path.join(outputRoot, "report", "report.json"), "utf8"));
  const attempt = report.tests[0].attempts.items[0];
  assert.ok(attempt.result.steps.some((step) =>
    step.diagnostic?.includes("AUDIT unrelated browser close receipt failure")));
});
async function verifyReport(entry, result) {
  const reportText = await readFile(result.bundle.reportPath, "utf8");
  const report = JSON.parse(reportText);
  assert.deepEqual(report, result.bundle.report);
  assert.equal(report.schemaVersion, "surfaceloom.report/v3");
  assert.equal(report.run.title, "SurfaceLoom P3-088 fault matrix");
  assert.match(report.run.id, new RegExp(`^reference-agent\\.p3-088\\.${entry.key}\\.`));
  assert.deepEqual(report.run.hosts.value.map((host) => host.id).sort(),
    [runnerHostId, browserHostId].sort());
  assert.deepEqual(report.run.surfaces.value.map((surface) => [surface.id, surface.kind]),
    [[browserSurfaceId, "browser"]]);
  assert.equal(report.tests.length, 1);
  const reportedCase = report.tests[0];
  assert.equal(reportedCase.spec.id, entry.id);
  assert.match(reportedCase.spec.intent, /验证/u);
  assert.equal(reportedCase.attempts.state, "known");
  assert.equal(reportedCase.attempts.finalAttemptId, "attempt-1");
  assert.equal(reportedCase.attempts.items.length, 1);
  const attempt = reportedCase.attempts.items[0];
  assert.equal(attempt.id, "attempt-1");
  assert.equal(attempt.ordinal, 1);
  assert.deepEqual(attempt.executionPlatforms, ["web"]);
  assert.deepEqual(attempt.runnerHostId, { state: "known", value: runnerHostId });
  assert.deepEqual(attempt.surfaceIds, { state: "known", value: [browserSurfaceId] });
  assert.equal(attempt.result.status, entry.expectedStatus);
  assert.equal(result.exitCode, entry.expectedStatus === "passed" ? 0 : 1);
  assertCriteria(entry, attempt.result.steps);
  const artifact = attempt.result.artifacts.find((item) => item.id === evidenceArtifactId);
  assert.ok(artifact, "required fault-matrix evidence is missing");
  assert.equal(artifact.captureStatus, "captured");
  const artifactPath = path.join(result.bundle.directory, artifact.relativePath);
  const artifactBytes = await readFile(artifactPath);
  assert.equal((await stat(artifactPath)).size, artifact.sizeBytes);
  assert.equal(sha256(artifactBytes), artifact.sha256);
  const evidence = JSON.parse(artifactBytes.toString("utf8"));
  assert.equal(evidence.scope.reportRunId, report.run.id);
  assert.equal(evidence.scope.attemptId, "attempt-1");
  assert.equal(evidence.scope.runnerHostId, runnerHostId);
  assert.equal(evidence.artifact.artifactId, evidenceArtifactId);
  assert.equal(evidence.content.kind, "probe");
  const value = evidence.content.value;
  assert.match(value.identity.runId, /^run-\d{6}$/u);
  assert.ok(value.identity.callIds.includes(value.identity.primaryCallId));
  assert.equal(value.identity.toolId, "append-note");
  assert.equal(value.localProbe.resource, "reference-agent.local-note");
  assert.equal(value.localProbe.boundary, "local");
  assert.equal(value.localProbe.diagnostic.state, "available");
  assert.equal(value.browserAction.action, entry.decision);
  assert.equal(value.browserAction.outcome, "succeeded");
  assert.notDeepEqual(value.browserAction, value.businessOutcome);
  assert.equal(value.businessOutcome.run.runId, value.identity.runId);
  assert.equal(value.ui.value.runId, value.identity.runId);
  assert.equal(value.approval.value.callId, value.identity.primaryCallId);
  assert.equal(value.diagnosticRawLedger.authority, "diagnostic-only");
  verifyScenario(entry, value, evidence, attempt.result, result);
  const html = await readFile(result.bundle.htmlPath, "utf8");
  const markdown = await readFile(result.bundle.aiReviewPath, "utf8");
  assert.equal(html, renderHTMLReportV3(report));
  assert.equal(markdown, renderAIReviewV3(report));
  const completion = JSON.parse(await readFile(result.bundle.completionMarkerPath, "utf8"));
  assert.equal(completion.report, "report.json");
  assert.equal(completion.reportSha256, sha256(reportText));
  assert.equal(completion.files["report.json"], sha256(reportText));
  assert.equal(completion.files["index.html"], sha256(html));
  assert.equal(completion.files["ai-review.md"], sha256(markdown));
}

function verifyScenario(entry, value, evidence, caseResult, result) {
  const observedLedger = value.ledgerObservation;
  const rawLedger = value.diagnosticRawLedger.value;
  const effects = value.localProbe.rawEffects;
  if (entry.key === "deny-but-execute") {
    assert.equal(value.ui.value.state, "denied");
    assert.deepEqual(value.tool.value, { runId: value.identity.runId,
      callId: value.identity.primaryCallId, requested: 1, started: 1, completed: 1 });
    assert.equal(effects.length, 1);
  } else if (entry.key === "duplicate-business-effect") {
    assert.deepEqual(value.identity.callIds,
      [`${value.identity.runId}:call-1`, `${value.identity.runId}:call-2`]);
    assert.equal(rawLedger.events.length, 6);
    assert.equal(effects.length, 2);
    assert.equal(new Set(effects.map((effect) => effect.logicalOperationId)).size, 1);
    assert.equal(value.tool.value.requested, 1);
    assert.equal(value.tool.value.started, 1);
    assert.equal(value.tool.value.completed, 1);
  } else if (entry.key === "missing-ledger") {
    assert.equal(observedLedger.state, "read-failed");
    assert.equal(observedLedger.error.code, "LEDGER_READ_FAILED");
    assert.equal(value.ledgerCompleteness.reason, "ledgerReadFailed");
    assert.equal(rawLedger.events.length, 3);
    assert.equal(effects.length, 1);
    assert.equal(evidence.completeness.state, "incomplete");
  } else if (entry.key === "truncated-ledger") {
    assert.equal(observedLedger.state, "available");
    assert.deepEqual(observedLedger.value.events.map((event) => event.sequence), [1, 2]);
    assert.equal(observedLedger.value.endBoundary.lastSequence, 3);
    assert.equal(value.ledgerCompleteness.reason, "ledgerTruncatedEventInterval");
    assert.equal(rawLedger.events.length, 3);
    assert.equal(effects.length, 1);
    assert.equal(evidence.completeness.state, "incomplete");
  } else if (entry.key === "stop-before-submit") {
    assertStop(value, "notExecuted", false, true, 0);
    assert.deepEqual(rawLedger.events.map((event) => event.phase), ["requested"]);
    assert.equal(rawLedger.complete, true);
  } else if (entry.key === "stop-after-submit") {
    assertStop(value, "unknown", true, true, 0);
    assert.deepEqual(rawLedger.events.map((event) => event.phase), ["requested", "started"]);
    assert.equal(rawLedger.complete, false);
    assert.equal(value.ledgerCompleteness.reason, "ledgerUnclosedOrInvalid");
    assert.equal(value.localProbe.observed.state, "unknown");
    assert.equal(value.localProbe.diagnostic.value.count, 0);
    assert.equal(value.localProbe.diagnostic.completeness, null);
  } else if (entry.key === "stop-after-effect") {
    assertStop(value, "executed", true, true, 1);
    assert.deepEqual(rawLedger.events.map((event) => event.phase),
      ["requested", "started", "completed"]);
    assert.equal(rawLedger.complete, true);
  } else {
    assert.equal(effects.length, 1);
    assert.equal(rawLedger.complete, false);
    const cleanupSteps = caseResult.steps.filter((step) => step.title === "fixtureTeardown");
    assert.ok(cleanupSteps.length >= 1);
    const cleanups = cleanupSteps.map((step) => JSON.parse(step.diagnostic).details)
      .filter((details) => details?.kind === "resourceCleanup").map((details) => details.data);
    assert.ok(cleanups.length >= 1);
    const cleanup = cleanups[0];
    assert.equal(cleanup.tainted, true);
    assert.equal(cleanup.status, "failed");
    assert.ok(cleanup.outcomes.some((item) => item.id.startsWith("reference-agent.run-work.")
      && item.status === "unconfirmed"));
    assert.ok(cleanup.outcomes.length > 1, "cleanup stopped before attempting sibling resources");
    assert.equal(result.cleanupState.calls, 1);
    assert.equal(result.recovery.settled.settled, true);
    assert.equal(result.recovery.effects.length, 1);
    assert.equal(result.recovery.ledger.complete, true);
    assert.equal(caseResult.status, "failed", "late recovery rewrote the published verdict");
  }
}

function assertStop(value, outcome, submitted, settled, effectCount) {
  assert.equal(value.businessOutcome.stopReceipt.outcome, outcome);
  assert.equal(value.businessOutcome.stopReceipt.submitted, submitted);
  assert.equal(value.businessOutcome.settleReceipt.settled, settled);
  assert.equal(value.businessOutcome.settleReceipt.status, "settled");
  assert.equal(value.localProbe.rawEffects.length, effectCount);
}

function assertCriteria(entry, steps) {
  const status = Object.fromEntries(steps.flatMap((step) =>
    (step.criterionIds ?? []).map((criterionId) => [criterionId, step.status])));
  for (const criterion of ["approval-requested"]) assert.equal(status[criterion], "passed");
  if (entry.key === "deny-but-execute") {
    assert.equal(status["ui-denied"], "passed");
    assert.equal(status["zero-tool-execution"], "failed");
    assert.equal(status["zero-business-effect"], "failed");
  }
  if (entry.key === "duplicate-business-effect") {
    assert.equal(status["ui-completed"], "passed");
    assert.equal(status["primary-call-exactly-once"], "passed");
    assert.equal(status["business-effect-exactly-one"], "failed");
  }
  if (["missing-ledger", "truncated-ledger"].includes(entry.key)) {
    assert.equal(status["ui-completed"], "passed");
    assert.equal(status["independent-effect-one"], "passed");
    assert.equal(status["ledger-call-exactly-once"], "failed");
  }
  if (entry.key === "stop-after-submit") {
    assert.equal(status["ui-cancelled"], "passed");
    assert.equal(status["stop-definitive-outcome"], "failed");
    assert.equal(status["ledger-call-exactly-once"], "failed");
    assert.equal(status["effect-zero-proven"], "failed");
  }
  if (["stop-before-submit", "stop-after-effect"].includes(entry.key)) {
    assert.ok(Object.values(status).every((item) => item === "passed"));
  }
  if (entry.key === "cleanup-unconfirmed") {
    assert.equal(status["effect-recorded-before-cleanup"], "passed");
    assert.equal(status["owned-work-registered"], "passed");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
