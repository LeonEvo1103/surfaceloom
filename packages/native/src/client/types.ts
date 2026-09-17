import type {
  HostDescriptor, JsonObject, NativeScope, OperationReceipt, WireRequest, WireResponse,
} from "../contracts.js";
import type { NativeResultCodec } from "./codec.js";
import type { NativeClientTransport } from "./transport.js";

export interface NativeClientRuntime {
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export interface NativeClientOptions {
  readonly transport: NativeClientTransport;
  readonly idFactory?: (kind: "request" | "operation" | "cancel") => string;
  readonly runtime?: NativeClientRuntime;
  /** Reports terminal responses that arrive after the caller stopped waiting. */
  readonly onLateResponse?: (event: Readonly<{
    readonly request: Readonly<{
      readonly id: string;
      readonly name: string;
      readonly intent: WireRequest["call"]["intent"];
      readonly operationId: string | null;
    }>;
    readonly response: WireResponse;
    readonly responsibility: "callerReconciliation";
    /** Transport/client shutdown is never an owned-resource cleanup receipt. */
    readonly cleanupConfirmed: false;
  }>) => void;
}

interface InvocationBase<T> {
  readonly name: string;
  readonly scope: NativeScope;
  readonly payload: JsonObject;
  readonly timeoutMs: number;
  readonly codec: NativeResultCodec<T>;
  readonly signal?: AbortSignal;
}

export interface ObserveInvocation<T> extends InvocationBase<T> {
  readonly intent: "observe";
  readonly operationId?: never;
}

export interface SideEffectInvocation<T> extends InvocationBase<T> {
  readonly intent: "mutate" | "lifecycle";
  readonly operationId?: string;
}

export type NativeInvocation<T> = ObserveInvocation<T> | SideEffectInvocation<T>;

export interface NativeInvocationResult<T> {
  readonly value: T;
  readonly operation: OperationReceipt | null;
}

export type NativeClientState = "idle" | "connecting" | "ready" | "disconnected" | "closed";

export interface NativeClientSnapshot {
  readonly state: NativeClientState;
  readonly host: HostDescriptor | null;
  readonly activeRequestCount: number;
  readonly trackedSessionCount: number;
  readonly trackedHandleCount: number;
}

export interface PendingNativeRequest<T> {
  readonly request: WireRequest;
  readonly codec: NativeResultCodec<T>;
}
