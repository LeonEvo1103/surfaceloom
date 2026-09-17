import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { materializeArtifacts } from "../artifacts.js";
import { defaultEvidencePolicy } from "../evidence-policy.js";
import type {
  CaseExecutionResultInput,
  EvidencePolicy,
  ReportedCaseExecutionResult,
} from "../model.js";
import { renderHTMLReportV3 } from "./render-html.js";
import { renderAIReviewV3 } from "./render-markdown.js";
import type {
  CaseReportV3Input,
  ReportBundleV3Input,
  ReportBundleV3Result,
  ReportedTestCaseV3,
  TestRunReportV3,
} from "./model.js";
import { reportSchemaVersionV3 } from "./model.js";
import { sanitizeReportV3Input } from "./sanitize.js";
import { overallStatusV3, summarizeTestsV3 } from "./summary.js";
import { validateEvidencePolicyV3 } from "./validate.js";

export interface WriteReportV3Options {
  readonly evidencePolicy?: Partial<EvidencePolicy>;
}

export async function writeReportV3Bundle(
  input: ReportBundleV3Input,
  outputDirectory: string,
  options: WriteReportV3Options = {},
): Promise<ReportBundleV3Result> {
  const snapshot = sanitizeReportV3Input(input);
  const evidencePolicy = Object.freeze({ ...defaultEvidencePolicy, ...options.evidencePolicy });
  validateEvidencePolicyV3(evidencePolicy);
  const output = path.resolve(outputDirectory);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  let createdOutput = false;
  try {
    await mkdir(output, { mode: 0o700 });
    createdOutput = true;
    const tests: ReportedTestCaseV3[] = [];
    for (const test of snapshot.tests) {
      tests.push(await materializeTest(output, test, evidencePolicy));
    }
    const frozenTests = Object.freeze(tests);
    const summary = summarizeTestsV3(frozenTests);
    const report: TestRunReportV3 = Object.freeze({
      schemaVersion: reportSchemaVersionV3,
      run: snapshot.run,
      status: overallStatusV3(summary),
      summary,
      evidencePolicy,
      tests: frozenTests,
    });
    return await writeViews(output, report);
  } catch (error) {
    if (createdOutput) await rm(output, { recursive: true, force: true });
    if (isAlreadyExists(error)) throw new Error("Report output already exists.", { cause: error });
    throw error;
  }
}

export function serializeReportV3(report: TestRunReportV3): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function materializeTest(
  output: string,
  test: CaseReportV3Input,
  policy: EvidencePolicy,
): Promise<ReportedTestCaseV3> {
  if (test.attempts.state === "unknown") {
    const result = await materializeResult(
      output, evidenceKey(test.spec.id, null), test.attempts.result, policy,
    );
    return Object.freeze({
      spec: test.spec,
      attempts: Object.freeze({
        state: "unknown",
        reason: test.attempts.reason,
        ...(test.attempts.detail === undefined ? {} : { detail: test.attempts.detail }),
        result,
      }),
    });
  }
  const items = [];
  for (const attempt of test.attempts.items) {
    const result = await materializeResult(
      output, evidenceKey(test.spec.id, attempt.id), attempt.result, policy,
    );
    items.push(Object.freeze({ ...attempt, result }));
  }
  return Object.freeze({
    spec: test.spec,
    attempts: Object.freeze({
      state: "known",
      finalAttemptId: test.attempts.finalAttemptId,
      items: Object.freeze(items),
    }),
  });
}

async function materializeResult(
  output: string,
  evidenceKey: string,
  result: CaseExecutionResultInput,
  policy: EvidencePolicy,
): Promise<ReportedCaseExecutionResult> {
  const artifacts = await materializeArtifacts(
    output, evidenceKey, result.status, result.artifacts ?? [], policy,
  );
  return Object.freeze({ ...result, artifacts });
}

async function writeViews(
  output: string,
  report: TestRunReportV3,
): Promise<ReportBundleV3Result> {
  const reportPath = path.join(output, "report.json");
  const htmlPath = path.join(output, "index.html");
  const aiReviewPath = path.join(output, "ai-review.md");
  const completionMarkerPath = path.join(output, "complete.json");
  const reportJSON = serializeReportV3(report);
  const pending = [
    { path: htmlPath, contents: renderHTMLReportV3(report) },
    { path: aiReviewPath, contents: renderAIReviewV3(report) },
    { path: reportPath, contents: reportJSON },
  ];
  await Promise.all(pending.map((file) => writeFile(`${file.path}.partial`, file.contents, {
    encoding: "utf8", flag: "wx", mode: 0o600,
  })));
  for (const file of pending) await rename(`${file.path}.partial`, file.path);
  const completion = {
    schemaVersion: "surfaceloom.report-bundle/v2",
    report: "report.json",
    reportSha256: digest(reportJSON),
    files: Object.fromEntries(pending.map((file) => [path.basename(file.path), digest(file.contents)])),
  };
  await writeFile(`${completionMarkerPath}.partial`, `${JSON.stringify(completion, null, 2)}\n`, {
    encoding: "utf8", flag: "wx", mode: 0o600,
  });
  await rename(`${completionMarkerPath}.partial`, completionMarkerPath);
  return Object.freeze({ directory: output, completionMarkerPath, reportPath, htmlPath,
    aiReviewPath, report });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceKey(caseId: string, attemptId: string | null): string {
  return JSON.stringify([caseId, attemptId]);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
