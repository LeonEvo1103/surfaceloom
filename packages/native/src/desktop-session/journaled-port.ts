import { randomUUID } from "node:crypto";
import { NativeClient, NativeClientError, NativeRemoteError } from "../client/index.js";
import type { NativeInvocationResult } from "../client/types.js";
import type { OperationReceipt } from "../contracts.js";
import type {
  DesktopSessionEvidenceSink,
  NativeDesktopOperation,
  NativeSessionIdentity,
} from "./contracts.js";

/** Receipt-preserving NativeClient path for one already-tracked session. */
export class JournaledDesktopSessionOperationPort {
  constructor(
    readonly client: NativeClient,
    readonly identity: NativeSessionIdentity,
    readonly evidence: DesktopSessionEvidenceSink,
    readonly operationIdFactory: () => string = () => `desktop-session-${randomUUID()}`,
  ) {}

  async invoke<T>(operation: NativeDesktopOperation<T>): Promise<NativeInvocationResult<T>> {
    const scope = operation.scope === "handle"
      ? Object.freeze({ kind: "handle" as const, ...this.identity })
      : Object.freeze({ kind: "session" as const, hostInstanceId: this.identity.hostInstanceId,
        sessionId: this.identity.sessionId });
    const operationId = operation.intent === "observe" ? undefined
      : operation.operationId ?? this.operationIdFactory();
    try {
      const common = { name: operation.method, scope, payload: operation.payload,
        timeoutMs: operation.timeoutMs, codec: operation,
        ...(operation.signal === undefined ? {} : { signal: operation.signal }) };
      const result = operation.intent === "observe"
        ? await this.client.invoke<T>({ ...common, intent: "observe" })
        : await this.client.invoke<T>({ ...common, intent: operation.intent,
          operationId: operationId! });
      this.record(operation.method, result.operation, "success");
      return result;
    } catch (error) {
      this.record(operation.method, errorReceipt(error, operationId), "error");
      throw error;
    }
  }

  private record(method: string, operation: OperationReceipt | null,
    status: "success" | "error"): void {
    this.evidence.append(Object.freeze({ method, identity: this.identity, operation, status }));
  }
}

function errorReceipt(error: unknown, operationId: string | undefined): OperationReceipt | null {
  if (error instanceof NativeRemoteError) return error.operation;
  if (error instanceof NativeClientError && error.operationOutcome !== null && operationId !== undefined) {
    return Object.freeze({ operationId, outcome: error.operationOutcome });
  }
  return null;
}
