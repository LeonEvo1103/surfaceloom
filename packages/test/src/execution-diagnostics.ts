import type { TestStepResult } from "@surfaceloom/reporter";
import { attachErrorDiagnostic } from "./errors.js";
import type { ResourceCleanupResult, ResourceFailure } from "./resources-contracts.js";
import type { WorkerStopSnapshot } from "./worker-contracts.js";

export function lifecycleError(message: string, kind: string, data: unknown): Error {
  const error = new Error(message);
  attachErrorDiagnostic(error, kind, data);
  return error;
}

export function attachCleanup(error: unknown, result: ResourceCleanupResult): Error | object {
  const target = error !== null && (typeof error === "object" || typeof error === "function")
    ? error as object : new Error(String(error));
  attachErrorDiagnostic(target, "resourceCleanup", result);
  return target;
}

export function passedLifecycleStep(worker: WorkerStopSnapshot): TestStepResult {
  return step("kernel.execution", "Execution producer settled", { worker });
}

export function cleanupStep(result: ResourceCleanupResult): TestStepResult {
  return step("kernel.cleanup", "Cleanup receipts", { cleanup: result });
}

export function absentCleanupStep(worker: WorkerStopSnapshot,
  cleanup: ResourceCleanupResult | undefined): TestStepResult {
  const acquired = worker.state !== "notStarted";
  const data = cleanup === undefined
    ? { state: "notStarted", receiptStatus: "unconfirmed", remaining: [] }
    : { ...cleanup, receiptStatus: "unconfirmed", executionTainted: acquired };
  return Object.freeze({
    ...step("kernel.cleanup", acquired ? "Cleanup receipt unavailable" : "No resources acquired",
      { cleanup: data, reason: acquired ? "producerUnconfirmed" : "notStarted" }),
    status: acquired ? "failed" as const : "passed" as const,
  });
}

export function cleanupFailureError(failure: ResourceFailure,
  originals: ReadonlyMap<string, unknown>, result: ResourceCleanupResult): Error | object {
  const original = failure.resourceId === undefined ? undefined : originals.get(failure.resourceId);
  return attachCleanup(original ?? new Error(failure.message), result);
}

function step(id: string, title: string, data: unknown): TestStepResult {
  return Object.freeze({ id, title, status: "passed", durationMs: 0,
    diagnostic: JSON.stringify({ schemaVersion: "surfaceloom.execution-diagnostic/v1", data }) });
}
