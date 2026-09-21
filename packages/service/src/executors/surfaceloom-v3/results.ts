import type {
  ResourceCleanupResult, RunCaseV3FailureOrigin, RunCaseV3Result,
} from "@surfaceloom/test";

import type { Artifact, ExecuteRequest, RunResult } from "../../execution.js";
import { deepFreeze } from "../../safe-data.js";
import type { CleanupReceipt } from "../../workspace.js";

type TestRunReportV3 = RunCaseV3Result["bundle"]["report"];

export function completedV3Result(request: Readonly<ExecuteRequest>, report: TestRunReportV3,
  artifacts: readonly Artifact[], cleanup: ResourceCleanupResult,
  failureOrigin: RunCaseV3FailureOrigin, cancelled: boolean,
  now: () => Date): RunResult {
  const receipt = cleanupReceipt(request, cleanup, now().toISOString());
  const base = resultBase(request, report.run.startedAt, report.run.finishedAt, artifacts, receipt);
  if (cancelled) return deepFreeze({ ...base, executionStatus: "cancelled", outcome: null,
    error: { code: "v3_cancelled", message: "SurfaceLoom v3 execution was cancelled.",
      retryable: false } });
  const final = finalCaseResult(report, request.definition.caseSpecs[0]!.id);
  if (final.status === "passed") {
    if (failureOrigin !== null) return incompleteKernelResult(base,
      "v3_failure_origin_mismatch", "A passing v3 Case retained a failure origin.");
    return deepFreeze({ ...base, executionStatus: "completed", outcome: "passed" });
  }
  if (final.status === "failed" && failureOrigin === "business") {
    return deepFreeze({ ...base, executionStatus: "completed", outcome: "failed",
      reason: final.error?.message ?? "SurfaceLoom v3 Case failed." });
  }
  if (final.status === "failed" && failureOrigin === "insufficient") {
    return deepFreeze({ ...base, executionStatus: "completed", outcome: "unknown",
      reason: final.error?.message ?? "SurfaceLoom v3 evidence was insufficient." });
  }
  if (final.status === "failed") return incompleteKernelResult(base,
    "v3_kernel_failed", final.error?.message ?? "SurfaceLoom v3 execution failed.");
  if (final.status === "timedOut") return incompleteKernelResult(base,
    "v3_deadline_exceeded", "SurfaceLoom v3 Case exceeded its execution deadline.");
  if (final.status === "skipped" || final.status === "unsupported") {
    return deepFreeze({ ...base, executionStatus: "completed", outcome: final.status,
      reason: final.reason ?? `SurfaceLoom v3 Case was ${final.status}.` });
  }
  return incompleteKernelResult(base, "v3_result_unclassified",
    "SurfaceLoom v3 returned an unclassified result.");
}

export function failedV3Result(request: Readonly<ExecuteRequest>, cause: unknown,
  artifacts: readonly Artifact[], cleanup: ResourceCleanupResult | undefined,
  cancelled: boolean, now: () => Date): RunResult {
  const attemptedAt = now().toISOString();
  const receipt = cleanup === undefined
    ? unconfirmed(request, attemptedAt, "SurfaceLoom v3 cleanup truth was unavailable.")
    : cleanupReceipt(request, cleanup, attemptedAt);
  return deepFreeze({ ...resultBase(request, attemptedAt, attemptedAt, artifacts, receipt),
    executionStatus: cancelled ? "cancelled" : "failed", outcome: null,
    error: { code: cancelled ? "v3_cancelled" : "v3_execution_failed",
      message: cause instanceof Error ? cause.message : "SurfaceLoom v3 execution failed.",
      retryable: false } });
}

export function notStartedV3Result(request: Readonly<ExecuteRequest>, code: string,
  message: string, now: () => Date): RunResult {
  const attemptedAt = now().toISOString();
  return deepFreeze({ ...resultBase(request, attemptedAt, attemptedAt, [], {
    runId: request.runId, snapshotId: request.snapshot.snapshotId, status: "not-required",
    tainted: false, attemptedAt }), executionStatus: "failed", outcome: null,
    error: { code, message, retryable: false } });
}

function finalCaseResult(report: TestRunReportV3, caseSpecId: string) {
  if (report.run.id.length === 0 || report.tests.length !== 1
      || report.tests[0]!.spec.id !== caseSpecId) {
    throw new Error("Reporter v3 result does not match the registered CaseSpec.");
  }
  const attempts = report.tests[0]!.attempts;
  if (attempts.state === "unknown") return attempts.result;
  const result = attempts.items.find((item) => item.id === attempts.finalAttemptId)?.result;
  if (result === undefined) throw new Error("Reporter v3 final attempt is missing.");
  return result;
}

function cleanupReceipt(request: Readonly<ExecuteRequest>, cleanup: ResourceCleanupResult,
  attemptedAt: string): CleanupReceipt {
  if (cleanup.state === "closed" && cleanup.status === "passed" && !cleanup.tainted) {
    return { runId: request.runId, snapshotId: request.snapshot.snapshotId,
      status: "confirmed", tainted: false, attemptedAt };
  }
  return unconfirmed(request, attemptedAt,
    cleanup.primaryFailure?.message ?? "SurfaceLoom v3 cleanup was not confirmed.");
}

function unconfirmed(request: Readonly<ExecuteRequest>, attemptedAt: string,
  detail: string): CleanupReceipt {
  return { runId: request.runId, snapshotId: request.snapshot.snapshotId,
    status: "unconfirmed", tainted: true, attemptedAt, detail };
}

function incompleteKernelResult(base: ReturnType<typeof resultBase>, code: string,
  message: string): RunResult {
  return deepFreeze({ ...base, executionStatus: "failed", outcome: null,
    error: { code, message, retryable: false } });
}

function resultBase(request: Readonly<ExecuteRequest>, startedAt: string, finishedAt: string,
  artifacts: readonly Artifact[], cleanup: CleanupReceipt) {
  return { runId: request.runId, snapshot: request.snapshot, testId: request.testId,
    parameters: request.parameters,
    ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
    ...(request.executionLinks === undefined ? {} : { executionLinks: request.executionLinks }),
    startedAt, finishedAt, artifacts, cleanup };
}
