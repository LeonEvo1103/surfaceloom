import type { CaseSpec } from "@surfaceloom/core";

import type {
  CaseReportInput,
  NormalizedCaseReportInput,
  ReportCaseSpecInput,
  ReportEnvironment,
  ReportRunInput,
  SourceArtifact,
  TestErrorSummary,
} from "./model.js";
import { redactReportText, redactTraceValue } from "./redact.js";

export function sanitizeRunInput(run: ReportRunInput): ReportRunInput {
  return Object.freeze({
    id: run.id,
    title: redactReportText(run.title),
    platform: run.platform,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    app: Object.freeze({
      id: run.app.id,
      name: redactReportText(run.app.name),
      ...(run.app.version === undefined
        ? {}
        : { version: redactReportText(run.app.version) }),
      ...(run.app.build === undefined
        ? {}
        : { build: redactReportText(run.app.build) }),
    }),
    ...(run.environment === undefined
      ? {}
      : { environment: sanitizeEnvironment(run.environment) }),
  });
}

export function sanitizeTestCase(test: NormalizedCaseReportInput): NormalizedCaseReportInput;
export function sanitizeTestCase(test: CaseReportInput): CaseReportInput;
export function sanitizeTestCase(test: CaseReportInput): CaseReportInput {
  return Object.freeze({
    spec: sanitizeCaseSpec(test.spec),
    result: Object.freeze({
      status: test.result.status,
      startedAt: test.result.startedAt,
      durationMs: test.result.durationMs,
      steps: Object.freeze(test.result.steps.map((step) => Object.freeze({
        id: step.id,
        title: redactReportText(step.title),
        status: step.status,
        durationMs: step.durationMs,
        ...(step.componentId === undefined
          ? {}
          : { componentId: redactReportText(step.componentId) }),
        ...(step.action === undefined
          ? {}
          : { action: redactReportText(step.action) }),
        ...(step.assertion === undefined
          ? {}
          : { assertion: redactReportText(step.assertion) }),
        ...(step.diagnostic === undefined
          ? {}
          : { diagnostic: redactReportText(step.diagnostic) }),
        ...(step.criterionIds === undefined
          ? {}
          : { criterionIds: Object.freeze([...step.criterionIds]) }),
      }))),
      ...(test.result.artifacts === undefined
        ? {}
        : { artifacts: Object.freeze(test.result.artifacts.map(sanitizeArtifact)) }),
      ...(test.result.error === undefined
        ? {}
        : { error: sanitizeError(test.result.error) }),
      ...(test.result.reason === undefined
        ? {}
        : { reason: redactReportText(test.result.reason) }),
    }),
  });
}

function sanitizeCaseSpec(spec: ReportCaseSpecInput): ReportCaseSpecInput {
  return Object.freeze({
    id: spec.id,
    locale: spec.locale,
    ...(Object.hasOwn(spec, "platforms")
      ? { platforms: Object.freeze([...(spec as CaseSpec).platforms]) }
      : {}),
    suite: Object.freeze({
      id: spec.suite.id,
      name: redactReportText(spec.suite.name),
    }),
    name: redactReportText(spec.name),
    ...(spec.sourceName === undefined
      ? {}
      : { sourceName: redactReportText(spec.sourceName) }),
    intent: redactReportText(spec.intent),
    preconditions: Object.freeze(spec.preconditions.map((item) => Object.freeze({
      id: item.id,
      text: redactReportText(item.text),
    }))),
    acceptanceCriteria: Object.freeze(spec.acceptanceCriteria.map((item) =>
      Object.freeze({ id: item.id, text: redactReportText(item.text) }),
    )),
    sideEffect: spec.sideEffect,
    ...(spec.tags === undefined
      ? {}
      : { tags: Object.freeze(spec.tags.map(redactReportText)) }),
  });
}

function sanitizeEnvironment(environment: ReportEnvironment): ReportEnvironment {
  return Object.freeze({
    ...(environment.osName === undefined
      ? {}
      : { osName: redactReportText(environment.osName) }),
    ...(environment.osVersion === undefined
      ? {}
      : { osVersion: redactReportText(environment.osVersion) }),
    ...(environment.runnerName === undefined
      ? {}
      : { runnerName: redactReportText(environment.runnerName) }),
    ...(environment.runnerVersion === undefined
      ? {}
      : { runnerVersion: redactReportText(environment.runnerVersion) }),
    ...(environment.commit === undefined
      ? {}
      : { commit: redactReportText(environment.commit) }),
    ...(environment.branch === undefined
      ? {}
      : { branch: redactReportText(environment.branch) }),
    ...(environment.ci === undefined ? {} : { ci: environment.ci }),
  });
}

function sanitizeArtifact(artifact: SourceArtifact): SourceArtifact {
  return Object.freeze({
    id: artifact.id,
    kind: artifact.kind,
    phase: artifact.phase,
    title: redactReportText(artifact.title),
    captureStatus: artifact.captureStatus,
    contentType: artifact.contentType,
    capturedAt: artifact.capturedAt,
    ...(artifact.sourcePath === undefined ? {} : { sourcePath: artifact.sourcePath }),
    ...(artifact.reviewPriority === undefined
      ? {}
      : { reviewPriority: artifact.reviewPriority }),
    ...(artifact.stepId === undefined ? {} : { stepId: artifact.stepId }),
    ...(artifact.description === undefined
      ? {}
      : { description: redactReportText(artifact.description) }),
    ...(artifact.captureError === undefined
      ? {}
      : { captureError: redactReportText(artifact.captureError) }),
    ...(artifact.sensitive === undefined ? {} : { sensitive: artifact.sensitive }),
    ...(artifact.durationMs === undefined ? {} : { durationMs: artifact.durationMs }),
    ...(artifact.relatedArtifactIds === undefined
      ? {}
      : { relatedArtifactIds: Object.freeze([...artifact.relatedArtifactIds]) }),
  });
}

function sanitizeError(error: TestErrorSummary): TestErrorSummary {
  return Object.freeze({
    category: redactReportText(error.category),
    message: redactReportText(error.message),
    ...(error.expected === undefined
      ? {}
      : { expected: redactTraceValue(error.expected) }),
    ...(error.actual === undefined
      ? {}
      : { actual: redactTraceValue(error.actual) }),
  });
}
