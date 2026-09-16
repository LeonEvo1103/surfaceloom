import type { NativeSessionDescriptor, OwnershipAction, WireRequest, WireResponse } from "./contracts.js";
import { NativeProtocolError } from "./protocol-error.js";

/**
 * Validates facts that require both halves of an exchange. Parsing one message
 * alone intentionally cannot claim request/operation correlation.
 */
export function validateResponseForRequest(request: WireRequest, response: WireResponse): void {
  if (request.id !== response.id) mismatch("Response id does not match its request.");
  const sideEffecting = request.call.intent !== "observe";
  if (!sideEffecting && response.operation !== null) {
    mismatch("Observe responses must not claim an operation outcome.");
  }
  if (sideEffecting) {
    if (response.operation === null || response.operation.operationId !== request.call.operationId) {
      mismatch("Side-effecting response is missing its matching operation receipt.");
    }
    if (response.ok && response.operation.outcome !== "executed") {
      mismatch("Successful side-effecting responses must prove executed.");
    }
  }
  if (!response.ok && response.error.retry === "safe"
    && response.operation?.outcome !== "notExecuted") {
    mismatch("A safe retry disposition requires a notExecuted receipt.");
  }
}

/** Ownership limits process lifecycle authority; releasing protocol state is always legal. */
export function assertOwnershipAllows(session: NativeSessionDescriptor, action: OwnershipAction): void {
  if (action !== "release" && session.ownership !== "owned") {
    throw new NativeProtocolError("ownership_required", `${action} requires an owned native session.`);
  }
}

/**
 * Transport loss cannot prove a side effect was skipped once its request frame
 * was fully written. This helper is deliberately conservative and never retries.
 */
export function disconnectedOperationOutcome(
  request: WireRequest,
  phase: "beforeWrite" | "writing" | "written",
): "notExecuted" | "unknown" | null {
  if (request.call.intent === "observe") return null;
  return phase === "beforeWrite" ? "notExecuted" : "unknown";
}

function mismatch(message: string): never {
  throw new NativeProtocolError("correlation_mismatch", message);
}
