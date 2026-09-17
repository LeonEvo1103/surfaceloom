import { defineCaseSpec, testPlatforms, type TestPlatform } from "@surfaceloom/core";

import type { CaseExecutionResultInput, EvidencePolicy } from "../model.js";
import { validateEvidencePolicy, validateReportInput } from "../validate.js";
import {
  validateIdentifier,
  validateNonEmpty,
  validateTimestamp,
  validateUnique,
} from "../validation-primitives.js";
import type {
  CaseReportV3Input,
  ContextValue,
  ReportBundleV3Input,
  ReportHostV3,
  ReportSurfaceV3,
  UnknownContextReason,
} from "./model.js";
import { validateRuntimeShapeV3 } from "./runtime-shape.js";

const hostOperatingSystems = new Set(["macos", "windows", "linux"]);
const surfaceKinds = new Set(["browser", "desktop", "system"]);
const unknownReasons = new Set<UnknownContextReason>([
  "notRecorded", "unavailable", "redacted", "notApplicable",
]);
const importLimitations = [
  "hostNotRecorded", "surfacesNotRecorded", "attemptsNotRecorded",
] as const;

export function validateReportV3Input(input: ReportBundleV3Input): void {
  validateRuntimeShapeV3(input);
  validateIdentifier("run id", input.run.id);
  validateNonEmpty("run title", input.run.title);
  validateIdentifier("app id", input.run.app.id);
  validateNonEmpty("app name", input.run.app.name);
  const runStarted = validateTimestamp("run.startedAt", input.run.startedAt);
  const runFinished = validateTimestamp("run.finishedAt", input.run.finishedAt);
  if (runFinished < runStarted) throw new Error("run.finishedAt must not precede startedAt.");
  if (input.tests.length === 0) throw new Error("A report must contain at least one test.");

  validateProvenance(input);
  validateContext(input.run.hosts, "run.hosts");
  validateContext(input.run.surfaces, "run.surfaces");
  validateHosts(input.run.hosts);
  validateSurfaces(input.run.surfaces, input.run.hosts);
  validateUnique("test id", input.tests.map((test) => test.spec.id));
  input.tests.forEach((test) => validateTest(input, test));
}

export function validateEvidencePolicyV3(policy: EvidencePolicy): void {
  validateEvidencePolicy(policy);
}

function validateProvenance(input: ReportBundleV3Input): void {
  const provenance = input.run.provenance;
  if (provenance.kind === "native") return;
  if (provenance.kind !== "imported-v2"
      || provenance.sourceSchemaVersion !== "surfaceloom.report/v2"
      || !testPlatforms.includes(provenance.sourcePlatform)) {
    throw new Error("Invalid report/v3 provenance.");
  }
  if (provenance.limitations.length !== importLimitations.length
      || provenance.limitations.some((item, index) => item !== importLimitations[index])) {
    throw new Error("A v2 import must declare all fixed information-loss limitations.");
  }
  if (input.run.hosts.state !== "unknown" || input.run.surfaces.state !== "unknown"
      || input.tests.some((test) => test.attempts.state !== "unknown")) {
    throw new Error("A v2 import must not claim known host, surface, or attempt data.");
  }
}

function validateHosts(hosts: ContextValue<readonly ReportHostV3[]>): void {
  if (hosts.state === "unknown") return;
  if (hosts.value.length === 0) throw new Error("Known hosts must contain at least one host.");
  validateUnique("host id", hosts.value.map((host) => host.id));
  for (const host of hosts.value) {
    validateIdentifier("host id", host.id);
    if (!hostOperatingSystems.has(host.os)) throw new Error("Unknown host operating system.");
    if (host.name !== undefined) validateNonEmpty("host name", host.name);
    if (host.osVersion !== undefined) validateNonEmpty("host OS version", host.osVersion);
    if (host.architecture !== undefined) validateNonEmpty("host architecture", host.architecture);
  }
}

function validateSurfaces(
  surfaces: ContextValue<readonly ReportSurfaceV3[]>,
  hosts: ContextValue<readonly ReportHostV3[]>,
): void {
  if (surfaces.state === "unknown") return;
  if (surfaces.value.length === 0) throw new Error("Known surfaces must contain at least one surface.");
  validateUnique("surface id", surfaces.value.map((surface) => surface.id));
  const hostIds = hosts.state === "known" ? new Set(hosts.value.map((host) => host.id)) : undefined;
  for (const surface of surfaces.value) {
    validateIdentifier("surface id", surface.id);
    if (!surfaceKinds.has(surface.kind)) throw new Error("Unknown surface kind.");
    validateReference(surface.hostId, "surface host id", hostIds);
    if (surface.name !== undefined) validateNonEmpty("surface name", surface.name);
    validateUnique("surface capability", surface.capabilities ?? []);
    for (const capability of surface.capabilities ?? []) {
      validateIdentifier("surface capability", capability);
    }
  }
}

function validateTest(input: ReportBundleV3Input, test: CaseReportV3Input): void {
  const spec = defineCaseSpec(test.spec);
  validateIdentifier("test id", spec.id);
  if (test.attempts.state === "unknown") {
    validateContext(test.attempts, `${spec.id}.attempts`);
    validateResult(input, spec, test.attempts.result);
    return;
  }
  const attempts = test.attempts;
  if (attempts.items.length === 0) throw new Error(`${spec.id} must contain an attempt.`);
  validateIdentifier("final attempt id", attempts.finalAttemptId);
  validateUnique("attempt id", attempts.items.map((attempt) => attempt.id));
  validateUnique("attempt ordinal", attempts.items.map((attempt) => String(attempt.ordinal)));
  const ordered = [...attempts.items].sort((left, right) => left.ordinal - right.ordinal);
  ordered.forEach((attempt, index) => {
    validateIdentifier("attempt id", attempt.id);
    if (!Number.isSafeInteger(attempt.ordinal) || attempt.ordinal !== index + 1) {
      throw new Error(`${spec.id} attempt ordinals must be contiguous positive integers.`);
    }
    if (attempt.executionPlatforms.length === 0) {
      throw new Error(`${spec.id}.${attempt.id} must record at least one execution platform.`);
    }
    validateUnique("attempt execution platform", attempt.executionPlatforms);
    for (const platform of attempt.executionPlatforms) {
      if (!testPlatforms.includes(platform) || !spec.platforms.includes(platform)) {
        throw new Error(`${spec.id}.${attempt.id} uses undeclared execution platform ${platform}.`);
      }
    }
    const hostIds = input.run.hosts.state === "known"
      ? new Set(input.run.hosts.value.map((host) => host.id)) : undefined;
    const surfaceIds = input.run.surfaces.state === "known"
      ? new Set(input.run.surfaces.value.map((surface) => surface.id)) : undefined;
    validateReference(attempt.runnerHostId, "attempt runner host id", hostIds);
    validateContext(attempt.surfaceIds, `${spec.id}.${attempt.id}.surfaceIds`);
    if (attempt.surfaceIds.state === "known") {
      if (attempt.surfaceIds.value.length === 0) {
        throw new Error(`${spec.id}.${attempt.id} must reference at least one surface.`);
      }
      validateUnique("attempt surface id", attempt.surfaceIds.value);
      for (const id of attempt.surfaceIds.value) {
        validateIdentifier("attempt surface id", id);
        if (surfaceIds !== undefined && !surfaceIds.has(id)) {
          throw new Error(`${spec.id}.${attempt.id} references unknown surface ${id}.`);
        }
      }
    }
    validateResult(input, spec, attempt.result);
  });
  if (!attempts.items.some((attempt) => attempt.id === attempts.finalAttemptId)) {
    throw new Error(`${spec.id} finalAttemptId references an unknown attempt.`);
  }
  if (ordered.at(-1)!.id !== attempts.finalAttemptId) {
    throw new Error(`${spec.id} finalAttemptId must reference the highest attempt ordinal.`);
  }
}

function validateResult(
  input: ReportBundleV3Input,
  spec: CaseReportV3Input["spec"],
  result: CaseExecutionResultInput,
): void {
  // v2 validation requires one matching platform. This local adapter validates
  // the unchanged Case/result contract only; report/v3 never persists it as a run platform.
  const validationPlatform = spec.platforms[0] as TestPlatform;
  validateReportInput({
    run: {
      id: input.run.id,
      title: input.run.title,
      platform: validationPlatform,
      startedAt: input.run.startedAt,
      finishedAt: input.run.finishedAt,
      app: input.run.app,
      ...(input.run.environment === undefined ? {} : { environment: input.run.environment }),
    },
    tests: [{ spec, result }],
  });
}

function validateReference(
  context: ContextValue<string>,
  label: string,
  knownIds: ReadonlySet<string> | undefined,
): void {
  validateContext(context, label);
  if (context.state === "unknown") return;
  validateIdentifier(label, context.value);
  if (knownIds === undefined) throw new Error(`A known ${label} requires a known catalog.`);
  if (!knownIds.has(context.value)) throw new Error(`Unknown ${label}: ${context.value}.`);
}

function validateContext<T>(context: ContextValue<T>, label: string): void {
  if (context.state === "known") return;
  if (context.state !== "unknown" || !unknownReasons.has(context.reason)) {
    throw new Error(`${label} has an invalid knowledge state.`);
  }
  if (context.detail !== undefined) validateNonEmpty(`${label} detail`, context.detail);
}
