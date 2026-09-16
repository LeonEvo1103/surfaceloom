import type { SideEffectLevel } from "@surfaceloom/core";
import { choice, flag, identifier, record } from "./plan-validation.js";

export const effectOperations = ["read", "write", "execute"] as const;
export const effectBoundaries = ["local", "external"] as const;
export const effectRecoveries = ["notNeeded", "resettable", "unknown"] as const;

export interface EffectDescriptor {
  /** Exact logical resource id; never a glob, credential, or user-content label. */
  readonly resource: string;
  readonly operation: (typeof effectOperations)[number];
  readonly boundary: (typeof effectBoundaries)[number];
  readonly securitySensitive: boolean;
  readonly recovery: (typeof effectRecoveries)[number];
}

export function defineEffect(value: EffectDescriptor): Readonly<EffectDescriptor> {
  const input = record(value, "effect", ["resource", "operation", "boundary", "securitySensitive", "recovery"]);
  return Object.freeze({
    resource: identifier(input.resource, "effect.resource"),
    operation: choice(input.operation, effectOperations, "effect.operation"),
    boundary: choice(input.boundary, effectBoundaries, "effect.boundary"),
    securitySensitive: flag(input.securitySensitive, "effect.securitySensitive"),
    recovery: choice(input.recovery, effectRecoveries, "effect.recovery"),
  });
}

/** Lossy summary only. No inverse mapping can infer a resource or recovery guarantee. */
export function effectSideEffectLevel(effect: EffectDescriptor): SideEffectLevel {
  const checked = defineEffect(effect);
  if (checked.securitySensitive) return "securitySensitive";
  if (checked.boundary === "external") return "externalEffect";
  if (checked.operation === "read") return "readOnly";
  if (checked.recovery === "resettable") return "reversible";
  return "writesLocal";
}

export function sameEffect(left: EffectDescriptor, right: EffectDescriptor): boolean {
  return left.resource === right.resource && left.operation === right.operation
    && left.boundary === right.boundary && left.securitySensitive === right.securitySensitive
    && left.recovery === right.recovery;
}
