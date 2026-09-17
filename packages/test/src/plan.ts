import { defineCaseSpec, desktopCapabilities, isSideEffectAtMost, testPlatforms } from "@surfaceloom/core";
import { defineEffect, effectSideEffectLevel, sameEffect, type EffectDescriptor } from "./effects.js";
import type { ExecutionEnvironment, ExecutionPlan, ExecutionPlanInput, ExecutionRequirements,
  SurfaceCapabilities } from "./plan-contracts.js";
import { ExecutionPolicyError } from "./plan-errors.js";
import { choice, choices, identifier, invalid, items, record } from "./plan-validation.js";

const hostOS = ["macos", "windows", "linux"] as const;
const surfaceKinds = ["browser", "desktop", "system"] as const;
const definedPlans = new WeakSet<ExecutionPlan>();

export function defineExecutionPlan(value: ExecutionPlanInput): Readonly<ExecutionPlan> {
  const input = record(value, "plan", ["spec", "requirements", "effects"]);
  let spec;
  try { spec = snapshotSpec(input.spec); }
  catch { invalid("plan.spec"); }
  const requirements = snapshotRequirements(input.requirements);
  let effectDeclaration: ExecutionPlan["effectDeclaration"];
  if (input.effects === undefined) {
    effectDeclaration = Object.freeze({ kind: "legacy", maximum: spec.sideEffect });
  } else {
    const effects = items(input.effects, "plan.effects").map((value) => defineEffect(value as EffectDescriptor));
    for (const [index, effect] of effects.entries()) {
      if (!isSideEffectAtMost(effectSideEffectLevel(effect), spec.sideEffect)) {
        throw new ExecutionPolicyError("incompatibleEffectSummary", "plan", { resource: effect.resource });
      }
      if (effects.slice(0, index).some((existing) => sameEffect(existing, effect))) invalid("plan.effects");
    }
    effectDeclaration = Object.freeze({ kind: "precise", effects: Object.freeze(effects) });
  }
  const plan = Object.freeze({ spec, requirements, effectDeclaration });
  definedPlans.add(plan);
  return plan;
}

/** Requires a validated immutable plan; structural lookalikes cannot bypass validation. */
export function requireExecutionPlan(plan: ExecutionPlan): void {
  if (!definedPlans.has(plan)) invalid("plan");
}

export function snapshotEnvironment(value: ExecutionEnvironment): Readonly<ExecutionEnvironment> {
  const input = record(value, "environment", ["platform", "host", "surfaces"]);
  const host = record(input.host, "environment.host", ["os"]);
  return Object.freeze({
    platform: choice(input.platform, testPlatforms, "environment.platform"),
    host: Object.freeze({ os: choice(host.os, hostOS, "environment.host.os") }),
    surfaces: snapshotSurfaces(input.surfaces, "environment.surfaces"),
  });
}

function snapshotRequirements(value: unknown): Readonly<ExecutionRequirements> {
  const input = record(value, "requirements", ["host", "surfaces"]);
  const surfaces = snapshotSurfaces(input.surfaces, "requirements.surfaces");
  if (input.host === undefined) return Object.freeze({ surfaces });
  const host = record(input.host, "requirements.host", ["os"]);
  const os = choices(host.os, hostOS, "requirements.host.os");
  if (os.length === 0) invalid("requirements.host.os");
  return Object.freeze({ host: Object.freeze({ os }), surfaces });
}

function snapshotSurfaces(value: unknown, path: string): Readonly<Record<string, SurfaceCapabilities>> {
  const input = record(value, path);
  const result: Record<string, SurfaceCapabilities> = Object.create(null) as Record<string, SurfaceCapabilities>;
  for (const [id, value] of Object.entries(input)) {
    identifier(id, `${path}.id`);
    const surface = record(value, `${path}.${id}`, ["kind", "capabilities"]);
    result[id] = Object.freeze({
      kind: choice(surface.kind, surfaceKinds, `${path}.${id}.kind`),
      capabilities: choices(surface.capabilities, desktopCapabilities, `${path}.${id}.capabilities`),
    });
  }
  return Object.freeze(result);
}

function snapshotSpec(value: unknown): ExecutionPlan["spec"] {
  const input = record(value, "plan.spec");
  const data = {
    ...input,
    suite: record(input.suite, "plan.spec.suite"),
    platforms: items(input.platforms, "plan.spec.platforms"),
    preconditions: items(input.preconditions, "plan.spec.preconditions").map((clause) => record(clause, "plan.spec.precondition")),
    acceptanceCriteria: items(input.acceptanceCriteria, "plan.spec.acceptanceCriteria").map((clause) => record(clause, "plan.spec.criterion")),
    ...(input.tags === undefined ? {} : { tags: items(input.tags, "plan.spec.tags") }),
  };
  return defineCaseSpec(data as unknown as ExecutionPlan["spec"]);
}
