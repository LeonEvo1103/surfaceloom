import type { DesktopCapability, DesktopPlatform } from "@surfaceloom/core";
import type { CaseContext } from "../contracts.js";
import type { EffectDescriptor } from "../effects.js";
import type { InteractiveSessionLease } from "../interactive-session-contracts.js";

export type NativeSessionOperation = keyof typeof nativeSessionOperationContracts;
export type NativeAcquisitionKind = "launch" | "attach";
export type NativeWireIntent = "observe" | "mutate" | "lifecycle";
export type NativeWireScopeKind = "host" | "session" | "handle";

export const nativeSessionOperationContracts = Object.freeze({
  find: contract("ui.inspect", "read", "notNeeded", "element.find", "observe", "session"),
  invoke: contract("ui.invoke", "write", "unknown", "element.action", "mutate", "handle", undefined, "invoke"),
  setValue: contract("ui.set-value", "write", "unknown", "element.action", "mutate", "handle", undefined, "setValue"),
  quit: contract("app.quit", "execute", "unknown", "session.close", "lifecycle", "session", "owned"),
  terminate: contract("app.terminate", "execute", "unknown", "session.terminate", "lifecycle", "session", "owned"),
} as const);

export const nativeAcquisitionContracts = Object.freeze({
  launch: contract("app.launch", "execute", "unknown", "session.launch", "lifecycle", "host", "owned"),
  attach: contract("app.attach", "read", "notNeeded", "session.attach", "lifecycle", "host", "borrowed"),
} as const);

function contract(capability: DesktopCapability, operation: EffectDescriptor["operation"],
  recovery: EffectDescriptor["recovery"], method: string, intent: NativeWireIntent,
  scope: NativeWireScopeKind, ownership?: NativeSessionIdentity["ownership"],
  action?: "invoke" | "setValue"): NativeOperationContract {
  return Object.freeze({ capability, method, intent, scope,
    ...(ownership === undefined ? {} : { ownership }),
    ...(action === undefined ? {} : { action }),
    effect: Object.freeze({ resource: `native.${capability}`, operation, boundary: "local",
      securitySensitive: false, recovery }) });
}

export interface NativeOperationContract {
  readonly capability: DesktopCapability;
  readonly effect: EffectDescriptor;
  readonly method: string;
  readonly intent: NativeWireIntent;
  readonly scope: NativeWireScopeKind;
  readonly ownership?: NativeSessionIdentity["ownership"];
  readonly action?: "invoke" | "setValue";
}

export interface NativeHostHandshake {
  readonly hostInstanceId: string;
  readonly hostChildIdentity: string;
  readonly platform: DesktopPlatform;
  readonly backend: string;
  readonly methods: readonly {
    readonly name: string;
    readonly intent: NativeWireIntent;
    readonly scopeKinds: readonly NativeWireScopeKind[];
  }[];
}

export interface NativeSessionIdentity {
  readonly hostInstanceId: string;
  readonly sessionId: string;
  readonly handleId: string;
  readonly targetIdentity: string;
  readonly ownership: "owned" | "borrowed";
  readonly surface: "application" | "system";
}

export interface NativeOperationReceipt {
  readonly operationId: string;
  readonly outcome: "notExecuted" | "executed" | "unknown";
}

export interface NativeOperationResult<T> {
  readonly value: T;
  readonly operation: NativeOperationReceipt | null;
}

export type NativeCleanupProof =
  | { readonly kind: "targetExit"; readonly hostInstanceId: string;
    readonly sessionId: string; readonly targetIdentity: string }
  | { readonly kind: "sessionRelease"; readonly hostInstanceId: string; readonly sessionId: string }
  | { readonly kind: "hostChildExit"; readonly hostInstanceId: string; readonly hostChildIdentity: string };

export interface NativeBindingPort {
  acquire(kind: NativeAcquisitionKind, options: NativeBindingCallOptions): Promise<NativeOperationResult<NativeSessionIdentity>>;
  reconcileLateAcquisition(options: NativeBindingCallOptions): Promise<NativeSessionIdentity | null>;
  invoke<T>(session: NativeSessionIdentity, contract: NativeOperationContract,
    payload: Readonly<Record<string, unknown>>, options: NativeBindingCallOptions): Promise<NativeOperationResult<T>>;
  cleanupTarget(session: NativeSessionIdentity): Promise<NativeCleanupProof | void>;
  releaseProtocol(session: NativeSessionIdentity): Promise<NativeCleanupProof | void>;
  closeHost(): Promise<NativeCleanupProof | void>;
}

export interface NativeBindingCallOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface NativeBindingOptions {
  readonly context: CaseContext;
  readonly handshake: NativeHostHandshake;
  readonly environmentPlatform: DesktopPlatform;
  readonly environmentCapabilities: readonly DesktopCapability[];
  readonly port: NativeBindingPort;
  readonly ownsHost?: boolean;
  readonly ownsProtocol?: boolean;
  /** Stable prefix used when more than one native surface shares one Case. */
  readonly resourceNamespace?: string;
  /** False when an adapter synchronously registered the host controller before handshake. */
  readonly registerHostResource?: boolean;
  readonly reconciliationTimeoutMs?: number;
  readonly cleanupSettleTimeoutMs?: number;
  readonly cleanupClock?: Readonly<{ readonly now: () => number }>;
  readonly lease?: InteractiveSessionLease;
}

export type NativeCleanupReceipt =
  | { readonly status: "released" }
  | { readonly status: "unconfirmed"; readonly reason: string };

export class NativeBindingError extends Error {
  constructor(readonly code: "aborted" | "capabilityMismatch" | "deadline" | "invalidOperation"
    | "invalidReceipt" | "staleScope" | "wrongOwnership", message: string) {
    super(message);
    this.name = "NativeBindingError";
  }
}
