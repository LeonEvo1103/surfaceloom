import type {
  ReportArtifact,
  ReportSummary,
  ReportedCaseExecutionResult,
  ReportedTestCase,
  SourceArtifact,
  TestRunReport,
} from "../model.js";
import { redactReportText } from "../redact.js";
import { safeArtifactPath } from "../safe-artifact-path.js";
import { sanitizeRunInput, sanitizeTestCase } from "../sanitize.js";
import { overallStatus, summarizeTests } from "../summary.js";
import { validateEvidencePolicy, validateReportInput } from "../validate.js";
import type { ReportedTestCaseV3, TestRunReportV3 } from "./model.js";
import { reportSchemaVersionV3 } from "./model.js";
import { snapshotDataValue } from "./runtime-shape.js";
import { overallStatusV3, summarizeTestsV3 } from "./summary.js";

const limitations = Object.freeze([
  "hostNotRecorded",
  "surfacesNotRecorded",
  "attemptsNotRecorded",
] as const);

/** Import canonical report/v2 JSON without inventing host, surface, or attempt facts. */
export function importReportV2(report: TestRunReport): TestRunReportV3 {
  const snapshot = snapshotDataValue(report, "report/v2 import") as TestRunReport;
  validateCanonicalV2(snapshot);
  const safeRun = sanitizeRunInput(snapshot.run);
  const tests = Object.freeze(snapshot.tests.map(importTest));
  const run = Object.freeze({
    id: safeRun.id,
    title: safeRun.title,
    startedAt: safeRun.startedAt,
    finishedAt: safeRun.finishedAt,
    app: safeRun.app,
    ...(safeRun.environment === undefined ? {} : { environment: safeRun.environment }),
    provenance: Object.freeze({
      kind: "imported-v2" as const,
      sourceSchemaVersion: "surfaceloom.report/v2" as const,
      sourcePlatform: safeRun.platform,
      limitations,
    }),
    hosts: Object.freeze({
      state: "unknown" as const,
      reason: "notRecorded" as const,
      detail: "report/v2 did not record host identity.",
    }),
    surfaces: Object.freeze({
      state: "unknown" as const,
      reason: "notRecorded" as const,
      detail: "report/v2 platform does not identify a surface or surface count.",
    }),
  });
  const summary = summarizeTestsV3(tests);
  const status = overallStatusV3(summary);
  return Object.freeze({
    schemaVersion: reportSchemaVersionV3,
    run,
    status,
    summary,
    evidencePolicy: Object.freeze({ ...snapshot.evidencePolicy }),
    tests,
  });
}

/** Alias with source-first naming for callers that discover importers by version. */
export const importV2Report = importReportV2;

function importTest(test: ReportedTestCase): ReportedTestCaseV3 {
  const sourceArtifacts = test.result.artifacts.map(asValidationArtifact);
  const sanitized = sanitizeTestCase({
    spec: test.spec,
    result: { ...test.result, artifacts: sourceArtifacts },
  });
  const result: ReportedCaseExecutionResult = Object.freeze({
    ...sanitized.result,
    artifacts: Object.freeze(test.result.artifacts.map(sanitizeReportedArtifact)),
  });
  return Object.freeze({
    spec: sanitized.spec,
    attempts: Object.freeze({
      state: "unknown",
      reason: "notRecorded",
      detail: "report/v2 recorded a Case result without an attempt boundary.",
      result,
    }),
  });
}

function validateCanonicalV2(report: TestRunReport): void {
  if (typeof report !== "object" || report === null
      || report.schemaVersion !== "surfaceloom.report/v2") {
    throw new Error("Expected a canonical surfaceloom.report/v2 report.");
  }
  validateEvidencePolicy(report.evidencePolicy);
  const tests = report.tests.map((test) => ({
    spec: test.spec,
    result: {
      ...test.result,
      artifacts: test.result.artifacts.map(asValidationArtifact),
    },
  }));
  validateReportInput({ run: report.run, tests });
  report.tests.flatMap((test) => test.result.artifacts).forEach(validateReportedArtifact);
  const summary = summarizeTests(report.tests);
  if (!sameSummary(summary, report.summary)
      || overallStatus(summary) !== report.status) {
    throw new Error("report/v2 summary or status is inconsistent with its test results.");
  }
}

function sameSummary(left: ReportSummary, right: ReportSummary): boolean {
  return left.discovered === right.discovered
    && left.executed === right.executed
    && left.passed === right.passed
    && left.failed === right.failed
    && left.timedOut === right.timedOut
    && left.skipped === right.skipped
    && left.unsupported === right.unsupported
    && left.evidence.captured === right.evidence.captured
    && left.evidence.captureFailed === right.evidence.captureFailed
    && left.evidence.unsupported === right.evidence.unsupported
    && left.evidence.notRequested === right.evidence.notRequested;
}

function asValidationArtifact(artifact: ReportArtifact): SourceArtifact {
  const {
    contentTrust: _contentTrust,
    relativePath: _relativePath,
    sizeBytes: _sizeBytes,
    sha256: _sha256,
    ...source
  } = artifact;
  return artifact.captureStatus === "captured"
    ? { ...source, sourcePath: "/imported-v2/evidence" }
    : source;
}

function validateReportedArtifact(artifact: ReportArtifact): void {
  if (artifact.contentTrust !== "untrusted") {
    throw new Error("Imported report/v2 evidence must remain untrusted.");
  }
  if (artifact.captureStatus === "captured") {
    if (artifact.relativePath === undefined || safeArtifactPath(artifact.relativePath) === undefined) {
      throw new Error("Captured report/v2 evidence has an unsafe or missing relative path.");
    }
    if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes! < 0) {
      throw new Error("Captured report/v2 evidence has an invalid byte size.");
    }
    if (!/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? "")) {
      throw new Error("Captured report/v2 evidence has an invalid SHA-256.");
    }
  } else if (artifact.relativePath !== undefined
      || artifact.sizeBytes !== undefined || artifact.sha256 !== undefined) {
    throw new Error("Uncaptured report/v2 evidence must not claim a materialized file.");
  }
}

function sanitizeReportedArtifact(artifact: ReportArtifact): ReportArtifact {
  return Object.freeze({
    id: artifact.id,
    kind: artifact.kind,
    phase: artifact.phase,
    title: redactReportText(artifact.title),
    captureStatus: artifact.captureStatus,
    contentType: artifact.contentType,
    capturedAt: artifact.capturedAt,
    contentTrust: "untrusted",
    ...(artifact.reviewPriority === undefined ? {} : { reviewPriority: artifact.reviewPriority }),
    ...(artifact.stepId === undefined ? {} : { stepId: artifact.stepId }),
    ...(artifact.description === undefined ? {} : {
      description: redactReportText(artifact.description),
    }),
    ...(artifact.sensitive === undefined ? {} : { sensitive: artifact.sensitive }),
    ...(artifact.durationMs === undefined ? {} : { durationMs: artifact.durationMs }),
    ...(artifact.relatedArtifactIds === undefined ? {} : {
      relatedArtifactIds: Object.freeze([...artifact.relatedArtifactIds]),
    }),
    ...(artifact.captureError === undefined ? {} : {
      captureError: redactReportText(artifact.captureError),
    }),
    ...(artifact.relativePath === undefined ? {} : { relativePath: artifact.relativePath }),
    ...(artifact.sizeBytes === undefined ? {} : { sizeBytes: artifact.sizeBytes }),
    ...(artifact.sha256 === undefined ? {} : { sha256: artifact.sha256 }),
  });
}
