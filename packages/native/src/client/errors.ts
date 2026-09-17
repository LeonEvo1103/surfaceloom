import type { OperationOutcome, OperationReceipt, WireError } from "../contracts.js";
import type { NativeWritePhase } from "./transport.js";

export type NativeClientIssueCode = "not_connected" | "closed" | "disconnected" | "deadline"
  | "cancelled" | "protocol_violation" | "decode_failed" | "stale_scope" | "write_failed"
  | "close_failed";

export class NativeClientError extends Error {
  readonly code: NativeClientIssueCode;
  readonly requestId: string | null;
  readonly operationOutcome: OperationOutcome | null;
  readonly writePhase: NativeWritePhase | null;

  constructor(code: NativeClientIssueCode, message: string, details: {
    readonly requestId?: string;
    readonly operationOutcome?: OperationOutcome | null;
    readonly writePhase?: NativeWritePhase | null;
    readonly cause?: unknown;
  } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "NativeClientError";
    this.code = code;
    this.requestId = details.requestId ?? null;
    this.operationOutcome = details.operationOutcome ?? null;
    this.writePhase = details.writePhase ?? null;
  }
}

export class NativeRemoteError extends Error {
  readonly wireError: WireError;
  readonly operation: OperationReceipt | null;

  constructor(wireError: WireError, operation: OperationReceipt | null) {
    super(wireError.message);
    this.name = "NativeRemoteError";
    this.wireError = wireError;
    this.operation = operation;
  }
}
