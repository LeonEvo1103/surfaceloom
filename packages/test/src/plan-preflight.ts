import type { ExecutionEnvironment, ExecutionPlan } from "./plan-contracts.js";
import { ExecutionPolicyError } from "./plan-errors.js";

export function checkExecutionRequirements(plan: ExecutionPlan, environment: ExecutionEnvironment): void {
  if (!plan.spec.platforms.includes(environment.platform)) {
    throw new ExecutionPolicyError("casePlatformUnsupported", "preflight", { platform: environment.platform });
  }
  if ((environment.platform !== "web" && environment.platform !== environment.host.os)
      || (plan.requirements.host !== undefined && !plan.requirements.host.os.includes(environment.host.os))) {
    throw new ExecutionPolicyError("hostUnsupported", "preflight", { os: environment.host.os });
  }
  for (const [id, requirement] of Object.entries(plan.requirements.surfaces)) {
    const available = environment.surfaces[id];
    if (available === undefined) {
      throw new ExecutionPolicyError("missingSurface", "preflight", { surface: id });
    }
    if (available.kind !== requirement.kind) {
      throw new ExecutionPolicyError("surfaceKindMismatch", "preflight", { surface: id });
    }
    for (const capability of requirement.capabilities) {
      if (!available.capabilities.includes(capability)) {
        throw new ExecutionPolicyError("missingCapability", "preflight", { surface: id, capability });
      }
    }
  }
}
