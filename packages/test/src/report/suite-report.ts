import {
  normalizeReportInput,
  overallStatus,
  sanitizeRunInput,
  sanitizeTestCase,
  summarizeTests,
  writeReportBundle,
  type NormalizedCaseReportInput,
  type ReportRunInput,
} from "@surfaceloom/reporter";
import {
  suiteExitCodes,
  type SuiteReportSnapshot,
  type SuiteReportWriteOptions,
  type WrittenSuiteReport,
} from "./contracts.js";

/** Build and validate the authoritative input shared by embedded and CLI callers. */
export function createSuiteReport(
  run: ReportRunInput,
  tests: readonly NormalizedCaseReportInput[],
): SuiteReportSnapshot {
  const normalized = normalizeReportInput({ run, tests });
  const input = Object.freeze({
    run: sanitizeRunInput(normalized.run),
    tests: Object.freeze(normalized.tests.map((test) => sanitizeTestCase(test))),
  });
  const summary = summarizeTests(input.tests);
  const status = overallStatus(summary);
  return Object.freeze({
    input,
    status,
    summary,
    exitCode: status === "passed" ? suiteExitCodes.passed : suiteExitCodes.testFailure,
  });
}

/** Materialize report.json and its deterministic Reporter-derived views. */
export async function writeSuiteReport(
  snapshot: SuiteReportSnapshot,
  outputDirectory: string,
  options: SuiteReportWriteOptions = {},
): Promise<WrittenSuiteReport> {
  const bundle = await writeReportBundle(snapshot.input, outputDirectory, options);
  if (bundle.report.status !== snapshot.status) {
    throw new Error("Written report status differs from the validated suite snapshot.");
  }
  return Object.freeze({ ...snapshot, bundle });
}
