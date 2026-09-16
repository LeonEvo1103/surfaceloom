import { defineCaseSpec, testPlatforms } from "@surfaceloom/core";

import type {
  EvidencePolicy,
  ReportBundleInput,
  NormalizedCaseReportInput,
  NormalizedReportBundleInput,
} from "./model.js";
import { validateRuntimeShape } from "./runtime-shape.js";
import { validateArtifact } from "./validate-artifact.js";
import {
  validateDuration,
  validateIdentifier,
  validateNonEmpty,
  validateStatus,
  validateTimestamp,
  validateUnique,
} from "./validation-primitives.js";

export function validateReportInput(input: ReportBundleInput): void {
  normalizeReportInput(input);
}

/**
 * Validates input and returns the canonical report/v2 shape. Legacy v2 cases
 * without `platforms` are assigned only the platform of this concrete run.
 */
export function normalizeReportInput(input: ReportBundleInput): NormalizedReportBundleInput {
  validateRuntimeShape(input);
  if (!testPlatforms.includes(input.run.platform)) {
    throw new Error("Unknown test platform.");
  }
  const normalized = Object.freeze({
    run: input.run,
    tests: Object.freeze(input.tests.map((test) => Object.freeze({
      spec: defineCaseSpec({
        ...test.spec,
        platforms: "platforms" in test.spec
          ? test.spec.platforms
          : [input.run.platform],
      }),
      result: test.result,
    }))),
  });
  validateNormalizedReportInput(normalized);
  return normalized;
}

function validateNormalizedReportInput(input: NormalizedReportBundleInput): void {
  validateIdentifier("run id", input.run.id);
  validateNonEmpty("run title", input.run.title);
  validateIdentifier("app id", input.run.app.id);
  validateNonEmpty("app name", input.run.app.name);
  const started = validateTimestamp("run.startedAt", input.run.startedAt);
  const finished = validateTimestamp("run.finishedAt", input.run.finishedAt);
  if (finished < started) throw new Error("run.finishedAt must not precede startedAt.");
  if (input.tests.length === 0) throw new Error("A report must contain at least one test.");

  for (const test of input.tests) validateIdentifier("test id", test.spec.id);
  validateUnique("test id", input.tests.map((test) => test.spec.id));
  for (const test of input.tests) {
    validateTest(test, input.run.platform, started, finished);
  }
}

export function validateEvidencePolicy(policy: EvidencePolicy): void {
  const expectedKeys = [
    "accessibilityTree",
    "logs",
    "screenshots",
    "trace",
    "video",
  ];
  const actualKeys = Object.keys(policy).sort();
  if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`Evidence policy keys must be exactly: ${expectedKeys.join(", ")}.`);
  }
  for (const [name, value] of Object.entries(policy)) {
    const accepted = name === "trace" || name === "logs"
      ? ["off", "always"]
      : ["off", "on-failure", "always"];
    if (!accepted.includes(value)) {
      throw new Error(`Unknown evidence retention for ${name}.`);
    }
  }
}

function validateTest(
  test: NormalizedCaseReportInput,
  runPlatform: (typeof testPlatforms)[number],
  runStarted: number,
  runFinished: number,
): void {
  const { spec, result } = test;
  if (!spec.platforms.includes(runPlatform)) {
    throw new Error(`${spec.id} does not support run platform ${runPlatform}.`);
  }
  validateIdentifier("test id", spec.id);
  validateIdentifier("suite id", spec.suite.id);
  for (const item of [...spec.preconditions, ...spec.acceptanceCriteria]) {
    validateIdentifier("case clause id", item.id);
  }
  validateUnique("precondition id", spec.preconditions.map((item) => item.id));
  validateUnique("acceptance criterion id", spec.acceptanceCriteria.map((item) => item.id));
  validateStatus(result.status);
  const testStarted = validateTimestamp(`${spec.id}.startedAt`, result.startedAt);
  validateDuration(`${spec.id}.durationMs`, result.durationMs);
  if (testStarted < runStarted || testStarted > runFinished) {
    throw new Error(`${spec.id}.startedAt must fall within the run window.`);
  }
  if (testStarted + result.durationMs > runFinished) {
    throw new Error(`${spec.id} duration must not exceed the run window.`);
  }
  if ((result.status === "failed" || result.status === "timedOut") && !result.error) {
    throw new Error(`${spec.id} must include an error for status ${result.status}.`);
  }
  if (result.status !== "failed" && result.status !== "timedOut" && result.error !== undefined) {
    throw new Error(`${spec.id} must not include an error for status ${result.status}.`);
  }
  if (result.error !== undefined) {
    validateNonEmpty("error category", result.error.category);
    validateNonEmpty("error message", result.error.message);
  }
  const needsReason = result.status === "skipped" || result.status === "unsupported";
  if (needsReason && result.reason === undefined) {
    throw new Error(`${spec.id} must include a reason for status ${result.status}.`);
  }
  if (!needsReason && result.reason !== undefined) {
    throw new Error(`${spec.id} must not include a reason for status ${result.status}.`);
  }
  if (result.reason !== undefined) {
    validateNonEmpty("execution reason", result.reason);
    if (spec.locale.toLowerCase().startsWith("zh")
        && !/\p{Script=Han}/u.test(result.reason)) {
      throw new Error(`${spec.id} must include a Chinese reason for status ${result.status}.`);
    }
  }
  for (const step of result.steps) validateIdentifier("step id", step.id);
  validateUnique("step id", result.steps.map((step) => step.id));
  const criterionIds = new Set(spec.acceptanceCriteria.map((item) => item.id));
  for (const step of result.steps) {
    validateIdentifier("step id", step.id);
    validateNonEmpty("step title", step.title);
    validateStatus(step.status);
    validateDuration(`${spec.id}.${step.id}.durationMs`, step.durationMs);
    validateUnique("step criterion id", step.criterionIds ?? []);
    for (const criterionId of step.criterionIds ?? []) {
      validateIdentifier("step criterion id", criterionId);
      if (!criterionIds.has(criterionId)) {
        throw new Error(`${spec.id}.${step.id} references unknown criterion ${criterionId}.`);
      }
    }
  }
  const nonPassingSteps = result.steps.filter((step) => step.status !== "passed");
  if (result.status === "passed" && nonPassingSteps.length > 0) {
    throw new Error(`${spec.id} is passed but contains a non-passing step.`);
  }
  if (result.status === "passed") {
    const coveredCriteria = new Set(result.steps.flatMap(
      (step) => step.status === "passed" ? step.criterionIds ?? [] : [],
    ));
    const missingCriteria = spec.acceptanceCriteria
      .map((item) => item.id)
      .filter((id) => !coveredCriteria.has(id));
    if (missingCriteria.length > 0) {
      throw new Error(
        `${spec.id} is passed but does not cover acceptance criteria: ${missingCriteria.join(", ")}.`,
      );
    }
  }
  const failingSteps = result.steps.filter(
    (step) => step.status === "failed" || step.status === "timedOut",
  );
  if (result.status !== "failed" && result.status !== "timedOut" && failingSteps.length > 0) {
    throw new Error(`${spec.id} has status ${result.status} but contains a failing step.`);
  }
  for (const artifact of result.artifacts ?? []) {
    validateIdentifier("artifact id", artifact.id);
  }
  validateUnique("artifact id", (result.artifacts ?? []).map((artifact) => artifact.id));
  for (const artifact of result.artifacts ?? []) {
    validateArtifact(spec.id, result.steps, artifact);
  }
  const artifactIds = new Set((result.artifacts ?? []).map((artifact) => artifact.id));
  for (const artifact of result.artifacts ?? []) {
    for (const related of artifact.relatedArtifactIds ?? []) {
      if (!artifactIds.has(related)) {
        throw new Error(`${artifact.id} references unknown artifact ${related}.`);
      }
    }
  }
}
