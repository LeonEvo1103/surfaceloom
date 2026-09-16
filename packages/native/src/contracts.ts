import type {
  cancellationReasons, errorCategories, nativeProtocolName, nativeProtocolVersion,
  operationIntents, operationOutcomes, retryDispositions, sessionOwnerships,
} from "./constants.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject { readonly [key: string]: JsonValue; }

export type OperationIntent = (typeof operationIntents)[number];
export type OperationOutcome = (typeof operationOutcomes)[number];
export type SessionOwnership = (typeof sessionOwnerships)[number];
export type ErrorCategory = (typeof errorCategories)[number];
export type RetryDisposition = (typeof retryDispositions)[number];
export type CancellationReason = (typeof cancellationReasons)[number];
export type NativeScopeKind = NativeScope["kind"];

export interface BootstrapScope { readonly kind: "bootstrap"; }
export interface HostScope { readonly kind: "host"; readonly hostInstanceId: string; }
export interface SessionScope {
  readonly kind: "session";
  readonly hostInstanceId: string;
  readonly sessionId: string;
}
export interface HandleScope {
  readonly kind: "handle";
  readonly hostInstanceId: string;
  readonly sessionId: string;
  readonly handleId: string;
}
export type NativeScope = BootstrapScope | HostScope | SessionScope | HandleScope;

export interface NativeHandle {
  readonly hostInstanceId: string;
  readonly sessionId: string;
  readonly handleId: string;
}

export interface NativeSessionDescriptor {
  readonly hostInstanceId: string;
  readonly sessionId: string;
  readonly ownership: SessionOwnership;
  readonly surface: "application" | "system";
  readonly root: NativeHandle;
}

export interface HostDescriptor {
  readonly hostInstanceId: string;
  readonly platform: string;
  readonly backend: string;
  readonly methods: readonly NativeMethodDescriptor[];
  readonly maxMessageBytes: number;
}

export interface NativeMethodDescriptor {
  readonly name: string;
  readonly intent: OperationIntent;
  readonly scopeKinds: readonly NativeScopeKind[];
}

export interface NativeCall {
  /** Product-neutral or platform-namespaced method; payload semantics belong to that method. */
  readonly name: string;
  readonly intent: OperationIntent;
  readonly scope: NativeScope;
  readonly payload: JsonObject;
  /** Required for mutate/lifecycle, forbidden for observe. It is correlation, not a retry token. */
  readonly operationId?: string;
}

export interface WireDeadline {
  /** Relative budget beginning when the complete frame arrives, before protocol/schema validation. */
  readonly timeoutMs: number;
}

interface WireHeader {
  readonly protocol: typeof nativeProtocolName;
  readonly version: typeof nativeProtocolVersion;
  readonly id: string;
}

export interface WireRequest extends WireHeader {
  readonly type: "request";
  readonly deadline: WireDeadline;
  readonly call: NativeCall;
}

export interface WireCancel extends WireHeader {
  readonly type: "cancel";
  readonly requestId: string;
  readonly reason: CancellationReason;
}

export interface OperationReceipt {
  readonly operationId: string;
  readonly outcome: OperationOutcome;
}

export interface WireError {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  /** "safe" is legal only with notExecuted; callers still decide whether to retry. */
  readonly retry: RetryDisposition;
  readonly details?: JsonObject;
}

export interface WireSuccess extends WireHeader {
  readonly type: "response";
  readonly ok: true;
  readonly result: JsonValue;
  readonly operation: OperationReceipt | null;
}

export interface WireFailure extends WireHeader {
  readonly type: "response";
  readonly ok: false;
  readonly error: WireError;
  readonly operation: OperationReceipt | null;
}

export type WireResponse = WireSuccess | WireFailure;
export type NativeWireMessage = WireRequest | WireCancel | WireResponse;

export type OwnershipAction = "release" | "close" | "terminate";
