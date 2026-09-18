import { NativeClientError, NativeRemoteError } from "../client/index.js";
import type { OperationReceipt } from "../contracts.js";
import { WindowsNativeError } from "./error.js";

export function normalizeWindowsError(error: unknown, message: string,
  operationId?: string): WindowsNativeError {
  if (error instanceof WindowsNativeError) return error;
  if (error instanceof NativeRemoteError) {
    return new WindowsNativeError("operationFailed", message, { cause: error,
      operationReceipt: error.operation, operationOutcome: error.operation?.outcome ?? null });
  }
  if (error instanceof NativeClientError) {
    const receipt: OperationReceipt | null = operationId === undefined || error.operationOutcome === null
      ? null : Object.freeze({ operationId, outcome: error.operationOutcome });
    return new WindowsNativeError(error.code === "deadline" ? "deadline" : "operationFailed", message,
      { cause: error, operationReceipt: receipt, operationOutcome: error.operationOutcome });
  }
  return new WindowsNativeError("operationFailed", message, { cause: error });
}
