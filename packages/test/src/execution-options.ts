import type { CaseSpec, TestPlatform } from "@surfaceloom/core";
import type { ExecuteCaseOptions } from "./contracts.js";
import type { DeadlineTaskOptions } from "./deadline-contracts.js";
import type { ExecutionEnvironment, ExecutionPlan } from "./plan-contracts.js";
import { ExecutionPolicyError } from "./plan-errors.js";
import { defineExecutionPlan, requireExecutionPlan, snapshotEnvironment } from "./plan.js";
import { preflightExecution, type ExecutionPolicyGate } from "./policy.js";

export interface PreparedExecution {
  readonly platform: TestPlatform;
  readonly deadline: DeadlineTaskOptions;
  readonly cleanupTimeoutMs: number;
  readonly plan: ExecutionPlan;
  readonly environment: ExecutionEnvironment;
  readonly gate: ExecutionPolicyGate;
}

/** Snapshot all caller-owned options before user code can mutate them. */
export function prepareExecution(spec: CaseSpec, options: ExecuteCaseOptions,
  platform: TestPlatform): PreparedExecution {
  const suppliedPlan = options.plan;
  const suppliedEnvironment = options.environment;
  const policy = options.policy;
  const timeoutMs = duration(options.timeoutMs ?? 30_000, "timeoutMs", true);
  const cancellationGraceMs = duration(options.cancellationGraceMs ?? 0,
    "cancellationGraceMs", true);
  const cleanupTimeoutMs = duration(options.cleanupTimeoutMs ?? 5_000,
    "cleanupTimeoutMs", false);
  const signal = options.signal;
  const clock = options.clock;
  const plan = suppliedPlan ?? defineExecutionPlan({ spec, requirements: { surfaces: {} } });
  requireExecutionPlan(plan);
  if (JSON.stringify(plan.spec) !== JSON.stringify(spec)) {
    throw new ExecutionPolicyError("invalidInput", "preflight", { case: spec.id });
  }
  const environment = snapshotEnvironment(suppliedEnvironment ?? {
    platform, host: { os: inferredHost(platform) }, surfaces: {},
  });
  if (environment.platform !== platform) {
    throw new ExecutionPolicyError("invalidInput", "preflight", { platform });
  }
  const gate = preflightExecution(plan, environment, policy);
  return Object.freeze({ platform, plan, environment, gate, cleanupTimeoutMs,
    deadline: Object.freeze({ timeoutMs, cancellationGraceMs,
      ...(signal === undefined ? {} : { signal }), ...(clock === undefined ? {} : { clock }) }) });
}

function duration(value: number, name: string, allowZero: boolean): number {
  const minimum = allowZero ? 0 : 1;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum
      || value > 2_147_483_647) {
    throw new Error(`${name} must be finite and between ${minimum} and 2147483647.`);
  }
  return value;
}

function inferredHost(platform: TestPlatform): ExecutionEnvironment["host"]["os"] {
  if (platform !== "web") return platform;
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}
