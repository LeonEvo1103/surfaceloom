import assert from "node:assert/strict";
import test from "node:test";

import {
  createOperationId,
  createRunId,
  createTaskId,
  parseTestId,
  type CompletedRunResult,
  type IncompleteRunResult,
  type RunCorrelation,
} from "../src/index.js";

function correlation(): RunCorrelation {
  return {
    runId: createRunId(),
    snapshot: { snapshotId: "snapshot-001", resolvedRevision: "abc123" },
    testId: parseTestId("service-test:reference/smoke"),
    parameters: { locale: "zh-CN", retries: 0 },
    taskId: createTaskId(),
    executionLinks: {
      caseSpecs: [{ namespace: "case-spec", caseSpecId: "case.login" }],
      agentRuns: [{
        namespace: "agent",
        agentRunId: "agent-run-1",
        agentCallIds: ["agent-call-1"],
      }],
      nativeOperations: [{ namespace: "native", nativeOperationId: "native-op-1" }],
    },
  };
}

test("run correlation binds snapshot, revision, service test, normalized params and optional Planner task", () => {
  const value = correlation();
  assert.equal(value.snapshot.snapshotId, "snapshot-001");
  assert.equal(value.snapshot.resolvedRevision, "abc123");
  assert.equal(value.testId, "service-test:reference/smoke");
  assert.deepEqual(value.parameters, { locale: "zh-CN", retries: 0 });
  assert.match(value.taskId!, /^task:/u);
  assert.equal(value.executionLinks?.caseSpecs[0]?.caseSpecId, "case.login");
  assert.equal(value.executionLinks?.agentRuns[0]?.agentCallIds[0], "agent-call-1");
  assert.equal(value.executionLinks?.nativeOperations[0]?.nativeOperationId, "native-op-1");
});

test("executor completion and business outcome remain independent", () => {
  const base = {
    ...correlation(),
    startedAt: "2026-09-20T00:00:00.000Z",
    finishedAt: "2026-09-20T00:00:01.000Z",
    artifacts: [],
    cleanup: {
      snapshotId: "snapshot-001",
      status: "confirmed" as const,
      tainted: false,
      attemptedAt: "2026-09-20T00:00:01.000Z",
    },
  };
  const businessFailure: CompletedRunResult = {
    ...base,
    executionStatus: "completed",
    outcome: "failed",
    reason: "A deterministic criterion failed.",
  };
  const infrastructureFailure: IncompleteRunResult = {
    ...base,
    executionStatus: "failed",
    outcome: null,
    error: { code: "executor_lost", message: "Executor disconnected.", retryable: false },
  };

  assert.equal(businessFailure.executionStatus, "completed");
  assert.equal(businessFailure.outcome, "failed");
  assert.equal(infrastructureFailure.outcome, null);
});

test("workspace operation identity remains distinct from the run correlation", () => {
  const operationId = createOperationId();
  const value = correlation();
  assert.match(operationId, /^operation:/u);
  assert.notEqual(operationId, value.runId);
});
