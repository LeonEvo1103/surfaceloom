import { errorSummary } from "./errors.js";
import type { WorkerSettlementSummary, WorkerTrackingOptions } from "./worker-contracts.js";

export function workerErrorMessage(error: unknown): string {
  return errorSummary("worker", error).message.slice(0, 2048);
}

function field(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined || !("value" in descriptor)) throw new Error("Worker receipt requires own data fields.");
  return descriptor.value;
}

export function workerEffects(options: WorkerTrackingOptions): "none" | "possible" {
  const value = field(options, "externalEffects");
  if (value !== "none" && value !== "possible") throw new Error("Worker externalEffects must be none or possible.");
  return value;
}

/** Snapshot only known receipt metadata; never stringify application payloads. */
export function workerSettlement(input: unknown, acknowledged: boolean): WorkerSettlementSummary {
  if (input === null || typeof input !== "object" || typeof acknowledged !== "boolean") {
    throw new Error("Invalid task settlement receipt.");
  }
  const status = field(input, "status");
  if (status !== "fulfilled" && status !== "rejected" && status !== "notStarted") {
    throw new Error("Invalid task settlement status.");
  }
  const observedAtMs = field(input, "observedAtMs");
  if (observedAtMs !== null && (typeof observedAtMs !== "number" || !Number.isFinite(observedAtMs))) {
    throw new Error("Invalid task settlement timestamp.");
  }
  const cancellation = field(input, "cancellation");
  if (cancellation !== null) {
    if (typeof cancellation !== "object") throw new Error("Invalid task cancellation receipt.");
    const kind = field(cancellation, "kind");
    const at = field(cancellation, "requestedAtMs");
    if (typeof kind !== "string" || !["deadline", "external", "requested", "clockFailed"].includes(kind)
      || typeof at !== "number" || !Number.isFinite(at)
      || typeof field(cancellation, "message") !== "string") throw new Error("Invalid task cancellation receipt.");
  }
  if ((status === "notStarted" || acknowledged) && cancellation === null) {
    throw new Error("A cancelled settlement requires a cancellation receipt.");
  }
  if (status === "notStarted" && acknowledged) throw new Error("An unstarted task cannot acknowledge cancellation.");
  if (status === "fulfilled") field(input, "value");
  const errorMessage = status === "rejected" ? workerErrorMessage(field(input, "reason")) : null;
  return Object.freeze({ status, observedAtMs, cancellationRequested: cancellation !== null,
    cancellationAcknowledged: acknowledged, errorMessage });
}

export function workerExitCode(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Worker exit receipt requires a non-negative integer exit code.");
  }
  return value;
}
