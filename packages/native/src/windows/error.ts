import type { OperationOutcome, OperationReceipt } from "../index.js";

export type WindowsNativeIssueCode = "invalidConfiguration" | "invalidHandshake" | "invalidPayload"
  | "invalidResult" | "capabilityMismatch" | "deadline" | "staleHandle"
  | "wrongOwnership" | "operationFailed" | "cleanupUnconfirmed";

/** Normalized error consumed by the existing native binding and v3 surface layer. */
export class WindowsNativeError extends Error {
  readonly operationOutcome: OperationOutcome | null;
  readonly operationReceipt: OperationReceipt | null;

  constructor(readonly code: WindowsNativeIssueCode, message: string, options: {
    readonly cause?: unknown;
    readonly operationReceipt?: OperationReceipt | null;
    readonly operationOutcome?: OperationOutcome | null;
  } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WindowsNativeError";
    this.operationReceipt = options.operationReceipt ?? null;
    this.operationOutcome = options.operationOutcome ?? this.operationReceipt?.outcome ?? null;
  }
}
