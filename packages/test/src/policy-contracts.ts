import type { SideEffectLevel } from "@surfaceloom/core";
import type { EffectDescriptor } from "./effects.js";

export interface EffectGrant {
  /** Exact logical resource id; wildcard and prefix matching are not supported. */
  readonly resource: string;
  readonly operations: readonly EffectDescriptor["operation"][];
  /** Defaults to local only. External access must be explicit. */
  readonly boundaries?: readonly EffectDescriptor["boundary"][];
  readonly allowSecuritySensitive?: boolean;
  readonly allowUnknownRecovery?: boolean;
}

/** Runner-owned configuration. A Case or ExecutionPlan cannot modify these grants. */
export interface ExecutionEffectPolicy {
  /** Defaults to writesLocal; each effect still requires a matching resource grant. */
  readonly maximumSideEffect?: SideEffectLevel;
  readonly grants?: readonly EffectGrant[];
}

export interface ResolvedEffectPolicy {
  readonly maximumSideEffect: SideEffectLevel;
  readonly grants: readonly Required<EffectGrant>[];
}
