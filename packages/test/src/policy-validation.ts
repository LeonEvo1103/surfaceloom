import { sideEffectLevels } from "@surfaceloom/core";
import { effectBoundaries, effectOperations } from "./effects.js";
import type { EffectGrant, ExecutionEffectPolicy, ResolvedEffectPolicy } from "./policy-contracts.js";
import { choice, choices, flag, identifier, invalid, items, record } from "./plan-validation.js";

export function snapshotEffectPolicy(value: ExecutionEffectPolicy): Readonly<ResolvedEffectPolicy> {
  const input = record(value, "policy", ["maximumSideEffect", "grants"]);
  const maximumSideEffect = input.maximumSideEffect === undefined ? "writesLocal"
    : choice(input.maximumSideEffect, sideEffectLevels, "policy.maximumSideEffect");
  const grants = items(input.grants === undefined ? [] : input.grants, "policy.grants").map(snapshotGrant);
  if (new Set(grants.map((grant) => grant.resource)).size !== grants.length) invalid("policy.grants");
  return Object.freeze({ maximumSideEffect, grants: Object.freeze(grants) });
}

function snapshotGrant(value: unknown): Readonly<Required<EffectGrant>> {
  const input = record(value, "grant", ["resource", "operations", "boundaries",
    "allowSecuritySensitive", "allowUnknownRecovery"]);
  const operations = choices(input.operations, effectOperations, "grant.operations");
  const boundaries = choices(input.boundaries === undefined ? ["local"] : input.boundaries,
    effectBoundaries, "grant.boundaries");
  if (operations.length === 0 || boundaries.length === 0) invalid("grant");
  return Object.freeze({
    resource: identifier(input.resource, "grant.resource"), operations, boundaries,
    allowSecuritySensitive: input.allowSecuritySensitive === undefined ? false
      : flag(input.allowSecuritySensitive, "grant.allowSecuritySensitive"),
    allowUnknownRecovery: input.allowUnknownRecovery === undefined ? false
      : flag(input.allowUnknownRecovery, "grant.allowUnknownRecovery"),
  });
}
