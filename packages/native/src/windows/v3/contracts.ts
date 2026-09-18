import type {
  EffectDescriptor, NativeSurfaceRequirement, ResourceCleanupReceipt, ResourceRegistration,
  SurfaceOwnership, UiaAction,
} from "@surfaceloom/test";

import type { WindowsDesktopCapability } from "../contracts.js";

export interface WindowsSurfaceBackendCall {
  readonly signal: AbortSignal;
  beforeSubmit(): { readonly signal: AbortSignal; readonly timeoutMs: number };
}

export interface WindowsSurfaceSetupContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  remainingMs(): number;
  dispatch<T>(effect: EffectDescriptor,
    action: (authorized: Readonly<EffectDescriptor>) => T | Promise<T>): Promise<T>;
  registerResource(resource: ResourceRegistration): void;
  readonly evidence: { submit(event: Readonly<{ kind: "acquired" | "operation" | "cleanup";
    surfaceId: string; outcome: "succeeded" | "failed" | "unknown"; operation?: string }>): void };
}

export type WindowsNativeAction<O extends SurfaceOwnership> = UiaAction
  | (O extends "owned" ? { readonly kind: "quit" } | { readonly kind: "terminate" } : never);

export interface WindowsNativeSurfaceSessionPort<O extends SurfaceOwnership> {
  readonly ownership: O;
  readonly platform: "windows";
  readonly backend: "uia";
  readonly capabilities: readonly WindowsDesktopCapability[];
  invoke(action: WindowsNativeAction<O>, context: WindowsSurfaceSetupContext,
    call: WindowsSurfaceBackendCall): Promise<unknown>;
}

export interface WindowsPreparedNativeAcquisition<O extends SurfaceOwnership> {
  acquire(call: WindowsSurfaceBackendCall): Promise<WindowsNativeSurfaceSessionPort<O>>;
}

/** Structurally implements @surfaceloom/test's native v3 backend port without a runtime import. */
export interface WindowsNativeSurfaceBackendPort {
  readonly hostId: string;
  readonly platform: "windows";
  readonly backend: "uia";
  readonly capabilities: readonly WindowsDesktopCapability[];
  prepare<O extends SurfaceOwnership>(requirement: NativeSurfaceRequirement<"windows", O>,
    context: WindowsSurfaceSetupContext): WindowsPreparedNativeAcquisition<O>;
}

export type WindowsHostCleanupReceipt = ResourceCleanupReceipt;
