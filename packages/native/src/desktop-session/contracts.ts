import type {
  HostDescriptor,
  JsonObject,
  NativeHandle,
  NativeSessionDescriptor,
  OperationReceipt,
} from "../contracts.js";
import type { NativeInvocationResult } from "../client/types.js";

export type NativeDesktopPlatform = "macos" | "windows";
export type NativeDesktopBackend<P extends NativeDesktopPlatform> =
  P extends "macos" ? "ax" : "uia";

export interface NativeSessionIdentity extends NativeHandle {}

export interface UiaLocator {
  readonly backend: "uia";
  readonly automationId?: string;
  readonly controlType?: string;
  readonly name?: string;
}

export interface AxLocator {
  readonly backend: "ax";
  readonly identifier?: string;
  readonly role?: string;
  readonly title?: string;
}

export type NativeLocatorFor<P extends NativeDesktopPlatform> =
  P extends "macos" ? AxLocator : UiaLocator;

export interface NativeDesktopOperation<T = unknown> {
  readonly method: string;
  readonly intent: "observe" | "mutate" | "lifecycle";
  readonly scope: "session" | "handle";
  readonly payload: JsonObject;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly operationId?: string;
  readonly decode: (value: unknown) => T;
}

export interface DesktopSessionOperationPort<P extends NativeDesktopPlatform> {
  readonly platform: P;
  invoke<T>(operation: NativeDesktopOperation<T>): Promise<NativeInvocationResult<T>>;
}

export interface DesktopSessionLifecyclePort {
  quit(options?: NativeLifecycleOptions): Promise<NativeInvocationResult<null>>;
  terminate(options?: NativeLifecycleOptions): Promise<NativeInvocationResult<null>>;
}

export interface NativeTargetExitProof extends NativeSessionIdentity {
  readonly kind: "targetExit";
  readonly targetIdentity: string;
}
export interface NativeSessionReleaseProof {
  readonly kind: "sessionRelease";
  readonly hostInstanceId: string;
  readonly sessionId: string;
}
export interface NativeHostChildExitProof {
  readonly kind: "hostChildExit";
  readonly hostInstanceId: string;
  readonly hostChildIdentity: string;
}
export interface DesktopSessionCleanupPort {
  targetExit(options?: NativeLifecycleOptions): Promise<NativeTargetExitProof>;
  release(options?: NativeLifecycleOptions): Promise<NativeSessionReleaseProof>;
}

export interface NativeLifecycleOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly operationId?: string;
}

export type DesktopSessionEvidence = Readonly<{
  readonly sequence: number;
  readonly method: string;
  readonly identity: NativeSessionIdentity;
  readonly operation: OperationReceipt | null;
  readonly status: "success" | "error";
}>;

export interface DesktopSessionEvidenceSink {
  append(evidence: Omit<DesktopSessionEvidence, "sequence">): void;
  snapshot(): readonly DesktopSessionEvidence[];
}

export interface CoreApplicationSessionIdentity<P extends NativeDesktopPlatform> {
  readonly id: string;
  readonly platform: P;
}

interface ApplicationDesktopSessionMetadata<P extends NativeDesktopPlatform> {
  readonly surface: "application";
  readonly backend: NativeDesktopBackend<P>;
  readonly nativeIdentity: NativeSessionIdentity;
  readonly nativeActions: {
    resolve(locator: NativeLocatorFor<P>): Promise<NativeHandle>;
  };
  readonly operationPort: DesktopSessionOperationPort<P>;
  readonly evidence: DesktopSessionEvidenceSink;
}

/** Adds native identity and receipts without replacing the Core AppSession surface. */
export type ApplicationDesktopSession<P extends NativeDesktopPlatform,
  CoreSession extends CoreApplicationSessionIdentity<P>> = ApplicationDesktopSessionMetadata<P> & (
    | (CoreSession & { readonly ownership: "owned"; readonly lifecyclePort: DesktopSessionLifecyclePort;
      readonly cleanupPort: DesktopSessionCleanupPort })
    | (Omit<CoreSession, "quit" | "terminate"> & { readonly ownership: "borrowed";
      readonly cleanupPort: Pick<DesktopSessionCleanupPort, "release"> })
  );

/** System automation is borrowed and deliberately has no synthetic AppTarget. */
export interface SystemDesktopSession<P extends NativeDesktopPlatform> {
  readonly id: string;
  readonly platform: P;
  readonly surface: "system";
  readonly backend: NativeDesktopBackend<P>;
  readonly nativeIdentity: NativeSessionIdentity;
  readonly ownership: "borrowed";
  readonly capabilities: readonly string[];
  readonly nativeActions: {
    resolve(locator: NativeLocatorFor<P>): Promise<NativeHandle>;
  };
  readonly operationPort: DesktopSessionOperationPort<P>;
  readonly cleanupPort: Pick<DesktopSessionCleanupPort, "release">;
  readonly evidence: DesktopSessionEvidenceSink;
}

export interface DesktopSessionHandshake {
  readonly host: HostDescriptor;
  readonly session: NativeSessionDescriptor;
}
