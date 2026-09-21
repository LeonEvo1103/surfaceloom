import type { RunResult } from "./execution.js";
import type { RunId } from "./ids.js";
import type { StoredRunRecord } from "./stores/contracts.js";
import type { CleanupReceipt } from "./workspace.js";

export function isTerminal(status: StoredRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
    || status === "interrupted";
}

export async function waitBounded(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function failClosedCleanup(result: RunResult): RunResult {
  if (cleanupIsSafe(result.cleanup)) return result;
  if (result.executionStatus !== "completed") return result;
  return { ...result, executionStatus: "failed", outcome: null,
    error: { code: "cleanup_unconfirmed", message: "Executor cleanup was not confirmed.",
      retryable: false } };
}

export function cleanupIsSafe(cleanup: CleanupReceipt): boolean {
  return cleanup.status !== "unconfirmed" && !cleanup.tainted;
}

export function interruptionCleanup(runId: RunId, snapshotId: string,
  attemptedAt: string): CleanupReceipt {
  return Object.freeze({ runId, snapshotId, status: "unconfirmed", tainted: true, attemptedAt,
    detail: "Owned process cleanup was not confirmed; workspace must remain quarantined." });
}

export function workspaceReleaseFailure(result: RunResult, cleanup: CleanupReceipt): RunResult {
  return { ...result, finishedAt: cleanup.attemptedAt, cleanup,
    executionStatus: "failed", outcome: null,
    error: { code: "workspace_release_unconfirmed",
      message: "Workspace release was not confirmed.", retryable: false } };
}
