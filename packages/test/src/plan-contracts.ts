import type { CaseSpec, DesktopCapability, SideEffectLevel, TestPlatform } from "@surfaceloom/core";
import type { EffectDescriptor } from "./effects.js";

export type HostOS = "macos" | "windows" | "linux";
export type SurfaceKind = "browser" | "desktop" | "system";

export interface SurfaceCapabilities {
  readonly kind: SurfaceKind;
  readonly capabilities: readonly DesktopCapability[];
}

export interface ExecutionRequirements {
  readonly host?: { readonly os: readonly HostOS[] };
  readonly surfaces: Readonly<Record<string, SurfaceCapabilities>>;
}

export interface ExecutionPlanInput {
  readonly spec: CaseSpec;
  readonly requirements: ExecutionRequirements;
  /** Omission keeps only the legacy ceiling; an empty list permits no effects. */
  readonly effects?: readonly EffectDescriptor[];
}

export interface ExecutionPlan {
  readonly spec: CaseSpec;
  readonly requirements: ExecutionRequirements;
  readonly effectDeclaration:
    | { readonly kind: "legacy"; readonly maximum: SideEffectLevel }
    | { readonly kind: "precise"; readonly effects: readonly EffectDescriptor[] };
}

/** Supplied by the runner/backend, never by the Case itself. */
export interface ExecutionEnvironment {
  readonly platform: TestPlatform;
  readonly host: { readonly os: HostOS };
  readonly surfaces: Readonly<Record<string, SurfaceCapabilities>>;
}
