import type { DesktopPlatform } from "@surfaceloom/core";

import type { EffectDescriptor } from "../effects.js";
import type { ResourceCleanupReceipt, ResourceRegistration } from "../resources-contracts.js";

export type SurfaceCapability = string;

export interface SurfaceEvidenceEvent {
  readonly kind: "acquired" | "operation" | "cleanup";
  readonly surfaceId: string;
  readonly outcome: "succeeded" | "failed" | "unknown";
  readonly operation?: string;
}

export interface SurfaceEvidenceSink {
  submit(event: SurfaceEvidenceEvent): void;
}

/** Deliberately excludes fixtures, Case steps, arbitrary hooks, and backend identities. */
export interface SurfaceSetupContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  remainingMs(): number;
  dispatch<T>(effect: EffectDescriptor,
    action: (authorized: Readonly<EffectDescriptor>) => T | Promise<T>): Promise<T>;
  registerResource(resource: ResourceRegistration): void;
  readonly evidence: SurfaceEvidenceSink;
}

export interface SurfaceBackendCall {
  readonly signal: AbortSignal;
  /** Must be called exactly once, immediately before the irreversible backend submission. */
  beforeSubmit(): { readonly signal: AbortSignal; readonly timeoutMs: number };
}

export interface DomLocator {
  readonly kind: "role" | "label" | "text" | "testId" | "css";
  readonly key: string;
  readonly value: string;
}

export type BrowserAction =
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "click"; readonly locator: DomLocator }
  | { readonly kind: "fill"; readonly locator: DomLocator; readonly value: string }
  | { readonly kind: "readText"; readonly locator: DomLocator }
  | { readonly kind: "waitVisible"; readonly locator: DomLocator };

export interface AxLocator {
  readonly backend: "ax";
  readonly identifier?: string;
  readonly role?: string;
  readonly title?: string;
}

export interface UiaLocator {
  readonly backend: "uia";
  readonly automationId?: string;
  readonly controlType?: string;
  readonly name?: string;
}

export type AxAction =
  | { readonly kind: "find"; readonly locator: AxLocator }
  | { readonly kind: "invoke"; readonly locator: AxLocator }
  | { readonly kind: "setValue"; readonly locator: AxLocator; readonly value: string };

export type UiaAction =
  | { readonly kind: "find"; readonly locator: UiaLocator }
  | { readonly kind: "invoke"; readonly locator: UiaLocator }
  | { readonly kind: "setValue"; readonly locator: UiaLocator; readonly value: string };

export type NativeElementAction<P extends DesktopPlatform> = P extends "macos" ? AxAction : UiaAction;
export type NativeOwnedAction<P extends DesktopPlatform> = NativeElementAction<P>
  | { readonly kind: "quit" }
  | { readonly kind: "terminate" };
export type NativeAction<P extends DesktopPlatform, O extends SurfaceOwnership> =
  O extends "owned" ? NativeOwnedAction<P> : NativeElementAction<P>;

export type SurfaceOwnership = "owned" | "borrowed";

export interface BrowserSurfaceRequirement {
  readonly kind: "browser";
  readonly surfaceId: string;
  readonly expectedHostId: string;
  readonly capabilities: readonly SurfaceCapability[];
  readonly engine: "chromium" | "firefox" | "webkit";
  readonly headless?: boolean;
  readonly timeoutMs?: number;
}

export interface NativeSurfaceRequirement<P extends DesktopPlatform, O extends SurfaceOwnership> {
  readonly kind: "native";
  readonly surfaceId: string;
  readonly expectedHostId: string;
  readonly platform: P;
  readonly backend: P extends "macos" ? "ax" : "uia";
  readonly acquisition: O extends "owned" ? "launch" : "attach";
  readonly capabilities: readonly SurfaceCapability[];
  readonly target: string;
  readonly timeoutMs?: number;
}

export interface BrowserCloseProof {
  readonly kind: "browserSessionClosed";
  readonly hostId: string;
  readonly sessionId: string;
}

export interface BrowserSurfaceSessionPort {
  readonly identity: { readonly hostId: string; readonly sessionId: string };
  invoke(action: BrowserAction, call: SurfaceBackendCall): Promise<unknown>;
  close(): Promise<BrowserCloseProof>;
}

export interface BrowserSurfaceBackendPort {
  readonly hostId: string;
  readonly capabilities: readonly SurfaceCapability[];
  launch(requirement: BrowserSurfaceRequirement,
    call: SurfaceBackendCall): Promise<BrowserSurfaceSessionPort>;
}

export interface NativeSurfaceSessionPort<P extends DesktopPlatform, O extends SurfaceOwnership> {
  readonly ownership: O;
  readonly platform: P;
  readonly backend: P extends "macos" ? "ax" : "uia";
  readonly capabilities: readonly SurfaceCapability[];
  invoke(action: NativeAction<P, O>, context: SurfaceSetupContext,
    call: SurfaceBackendCall): Promise<unknown>;
}

export interface PreparedNativeAcquisition<P extends DesktopPlatform, O extends SurfaceOwnership> {
  acquire(call: SurfaceBackendCall): Promise<NativeSurfaceSessionPort<P, O>>;
}

/** Adapter implementations may delegate to acquireNativeApplication; this package does not import it. */
export interface NativeSurfaceBackendPort<P extends DesktopPlatform> {
  readonly hostId: string;
  readonly platform: P;
  readonly backend: P extends "macos" ? "ax" : "uia";
  readonly capabilities: readonly SurfaceCapability[];
  /** Must synchronously arrange controller, cleanup, and late-acquisition handling. */
  prepare<O extends SurfaceOwnership>(requirement: NativeSurfaceRequirement<P, O>,
    context: SurfaceSetupContext): PreparedNativeAcquisition<P, O>;
}

export interface SurfaceLease {
  readonly id: string;
  release(): ResourceCleanupReceipt | Promise<ResourceCleanupReceipt>;
}

export interface BrowserSurfaceAuthor {
  readonly kind: "browser";
  readonly surfaceId: string;
  readonly capabilities: readonly SurfaceCapability[];
  perform(action: BrowserAction, options?: { readonly timeoutMs?: number }): Promise<unknown>;
}

export interface NativeSurfaceAuthor<P extends DesktopPlatform, O extends SurfaceOwnership> {
  readonly kind: "native";
  readonly surfaceId: string;
  readonly platform: P;
  readonly backend: P extends "macos" ? "ax" : "uia";
  readonly ownership: O;
  readonly capabilities: readonly SurfaceCapability[];
  perform(action: NativeAction<P, O>, options?: { readonly timeoutMs?: number }): Promise<unknown>;
}
