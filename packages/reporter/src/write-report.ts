import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { materializeArtifacts } from "./artifacts.js";
import { defaultEvidencePolicy } from "./evidence-policy.js";
import type {
  EvidencePolicy,
  ReportBundleInput,
  ReportBundleResult,
  ReportedTestCase,
  TestRunReport,
} from "./model.js";
import { reportSchemaVersion } from "./model.js";
import { renderHTMLReport } from "./render-html.js";
import { renderAIReview } from "./render-markdown.js";
import { sanitizeRunInput, sanitizeTestCase } from "./sanitize.js";
import { overallStatus, summarizeTests } from "./summary.js";
import {
  normalizeReportInput,
  validateEvidencePolicy,
  validateReportInput,
} from "./validate.js";

export interface WriteReportOptions {
  readonly evidencePolicy?: Partial<EvidencePolicy>;
}

export async function writeReportBundle(
  input: ReportBundleInput,
  outputDirectory: string,
  options: WriteReportOptions = {},
): Promise<ReportBundleResult> {
  const normalizedInput = normalizeReportInput(input);
  const safeRun = sanitizeRunInput(normalizedInput.run);
  const safeTests = Object.freeze(
    normalizedInput.tests.map((test) => sanitizeTestCase(test)),
  );
  const snapshot = Object.freeze({ run: safeRun, tests: safeTests });
  validateReportInput(snapshot);
  const evidencePolicy = Object.freeze({
    ...defaultEvidencePolicy,
    ...options.evidencePolicy,
  });
  validateEvidencePolicy(evidencePolicy);
  const output = path.resolve(outputDirectory);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  let createdOutput = false;

  try {
    await mkdir(output, { mode: 0o700 });
    createdOutput = true;
    const tests: ReportedTestCase[] = [];
    for (const safeTest of snapshot.tests) {
      const artifacts = await materializeArtifacts(
        output,
        safeTest.spec.id,
        safeTest.result.status,
        safeTest.result.artifacts ?? [],
        evidencePolicy,
      );
      tests.push(Object.freeze({
        spec: safeTest.spec,
        result: Object.freeze({ ...safeTest.result, artifacts }),
      }));
    }
    const summary = summarizeTests(tests);
    const report: TestRunReport = Object.freeze({
      schemaVersion: reportSchemaVersion,
      run: snapshot.run,
      status: overallStatus(summary),
      summary,
      evidencePolicy,
      tests: Object.freeze(tests),
    });
    const reportPath = path.join(output, "report.json");
    const htmlPath = path.join(output, "index.html");
    const aiReviewPath = path.join(output, "ai-review.md");
    const completionMarkerPath = path.join(output, "complete.json");
    const reportJSON = `${JSON.stringify(report, null, 2)}\n`;
    const pendingFiles = [
      { path: htmlPath, contents: renderHTMLReport(report) },
      { path: aiReviewPath, contents: renderAIReview(report) },
      { path: reportPath, contents: reportJSON },
    ];
    await Promise.all(pendingFiles.map((file) => writeFile(
      `${file.path}.partial`,
      file.contents,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    )));
    for (const file of pendingFiles) await renamePartial(file.path);
    const completionMarker = {
      schemaVersion: "surfaceloom.report-bundle/v1",
      report: "report.json",
      reportSha256: createHash("sha256").update(reportJSON).digest("hex"),
      files: Object.fromEntries(pendingFiles.map((file) => [
        path.basename(file.path),
        createHash("sha256").update(file.contents).digest("hex"),
      ])),
    };
    await writeFile(
      `${completionMarkerPath}.partial`,
      `${JSON.stringify(completionMarker, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await renamePartial(completionMarkerPath);
    return Object.freeze({
      directory: output,
      completionMarkerPath,
      reportPath,
      htmlPath,
      aiReviewPath,
      report,
    });
  } catch (error) {
    if (createdOutput) await rm(output, { recursive: true, force: true });
    if (isAlreadyExists(error)) {
      throw new Error("Report output already exists.", { cause: error });
    }
    throw error;
  }
}

async function renamePartial(finalPath: string): Promise<void> {
  await rename(`${finalPath}.partial`, finalPath);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "EEXIST";
}
