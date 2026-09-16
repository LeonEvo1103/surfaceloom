import type { SideEffectLevel } from "@surfaceloom/core";
import type { EffectDescriptor } from "../src/effects.js";
import type { ExecutionEnvironment, ExecutionPlan, ExecutionRequirements } from "../src/plan-contracts.js";
import { ExecutionPolicyError, type ExecutionPolicyErrorCode } from "../src/plan-errors.js";
import { defineExecutionPlan } from "../src/plan.js";
import type { ExecutionEffectPolicy } from "../src/policy-contracts.js";
import { spec } from "./support.js";

export const effect = (overrides: Partial<EffectDescriptor> = {}): EffectDescriptor => ({
  resource: "fixture.document", operation: "read", boundary: "local",
  securitySensitive: false, recovery: "notNeeded", ...overrides,
});

export const environment = (): ExecutionEnvironment => ({
  platform: "web", host: { os: "linux" },
  surfaces: { ui: { kind: "browser", capabilities: ["browser.dom.inspect", "browser.dom.invoke"] } },
});

export const requirements = (): ExecutionRequirements => ({
  surfaces: { ui: { kind: "browser", capabilities: ["browser.dom.inspect"] } },
});

export function plan(maximum: SideEffectLevel = "writesLocal", effects?: readonly EffectDescriptor[]): ExecutionPlan {
  return defineExecutionPlan({
    spec: { ...spec("policy.case"), sideEffect: maximum }, requirements: requirements(),
    ...(effects === undefined ? {} : { effects }),
  });
}

export const localPolicy = (): ExecutionEffectPolicy => ({
  grants: [{ resource: "fixture.document", operations: ["read", "write", "execute"] }],
});

export function errorCode(code: ExecutionPolicyErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof ExecutionPolicyError && error.code === code;
}
