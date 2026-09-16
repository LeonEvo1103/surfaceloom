import { isSideEffectAtMost } from "@surfaceloom/core";
import { defineEffect, effectSideEffectLevel, sameEffect, type EffectDescriptor } from "./effects.js";
import type { ExecutionEnvironment, ExecutionPlan } from "./plan-contracts.js";
import { ExecutionPolicyError } from "./plan-errors.js";
import { checkExecutionRequirements } from "./plan-preflight.js";
import { invalid } from "./plan-validation.js";
import { requireExecutionPlan, snapshotEnvironment } from "./plan.js";
import type { ExecutionEffectPolicy, ResolvedEffectPolicy } from "./policy-contracts.js";
import { snapshotEffectPolicy } from "./policy-validation.js";

/** Preflight before setup/dispatch. This API is not yet wired into executeCase. */
export function preflightExecution(
  plan: ExecutionPlan,
  environment: ExecutionEnvironment,
  policy: ExecutionEffectPolicy = {},
): ExecutionPolicyGate {
  return new ExecutionPolicyGate(plan, environment, policy);
}

/**
 * A runner-owned guard for declared actions, not a JavaScript security sandbox.
 * Backend capabilities must be truthful; resource identity is exact, not a path scope.
 */
export class ExecutionPolicyGate {
  readonly #plan: ExecutionPlan;
  readonly #policy: ResolvedEffectPolicy;

  constructor(plan: ExecutionPlan, environment: ExecutionEnvironment, policy: ExecutionEffectPolicy = {}) {
    requireExecutionPlan(plan);
    this.#plan = plan;
    this.#policy = snapshotEffectPolicy(policy);
    checkExecutionRequirements(plan, snapshotEnvironment(environment));
    if (!isSideEffectAtMost(plan.spec.sideEffect, this.#policy.maximumSideEffect)) {
      throw new ExecutionPolicyError("effectLimitExceeded", "preflight", { maximum: this.#policy.maximumSideEffect });
    }
    if (plan.effectDeclaration.kind === "precise") {
      for (const effect of plan.effectDeclaration.effects) this.#checkPolicy(effect, "preflight");
    }
    Object.freeze(this);
  }

  /** Authorizes a snapshot; the legacy summary never supplies a missing descriptor. */
  check(effect: EffectDescriptor): Readonly<EffectDescriptor> {
    let checked: Readonly<EffectDescriptor>;
    try {
      checked = defineEffect(effect);
    } catch (error) {
      if (error instanceof ExecutionPolicyError && error.code === "invalidInput") {
        throw new ExecutionPolicyError("invalidInput", "authorize", error.details);
      }
      throw error;
    }
    if (!isSideEffectAtMost(effectSideEffectLevel(checked), this.#plan.spec.sideEffect)) {
      throw new ExecutionPolicyError("incompatibleEffectSummary", "authorize", { resource: checked.resource });
    }
    const declaration = this.#plan.effectDeclaration;
    if (declaration.kind === "precise" && !declaration.effects.some((item) => sameEffect(item, checked))) {
      throw new ExecutionPolicyError("undeclaredEffect", "authorize", { resource: checked.resource });
    }
    this.#checkPolicy(checked, "authorize");
    return checked;
  }

  /** Calls the action once after authorization; no retries, receipts, or cancellation are inferred. */
  async dispatch<T>(effect: EffectDescriptor, action: (authorized: Readonly<EffectDescriptor>) => T | Promise<T>): Promise<T> {
    if (typeof action !== "function") invalid("action");
    const authorized = this.check(effect);
    return await action(authorized);
  }

  #checkPolicy(effect: EffectDescriptor, phase: "preflight" | "authorize"): void {
    const details = { resource: effect.resource };
    if (!isSideEffectAtMost(effectSideEffectLevel(effect), this.#policy.maximumSideEffect)) {
      throw new ExecutionPolicyError("effectLimitExceeded", phase, details);
    }
    const grant = this.#policy.grants.find((item) => item.resource === effect.resource);
    if (grant === undefined) throw new ExecutionPolicyError("resourceDenied", phase, details);
    if (!grant.operations.includes(effect.operation)) {
      throw new ExecutionPolicyError("operationDenied", phase, details);
    }
    if (!grant.boundaries.includes(effect.boundary)) {
      throw new ExecutionPolicyError(effect.boundary === "external" ? "externalEffectDenied" : "boundaryDenied", phase, details);
    }
    if (effect.securitySensitive && !grant.allowSecuritySensitive) {
      throw new ExecutionPolicyError("securitySensitiveDenied", phase, details);
    }
    if (effect.recovery === "unknown" && !grant.allowUnknownRecovery) {
      throw new ExecutionPolicyError("unknownRecoveryDenied", phase, details);
    }
  }
}
