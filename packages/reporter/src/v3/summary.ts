import type { CaptureStatus, RunStatus, TestStatus } from "../model.js";
import type { ReportSummaryV3, ReportedTestCaseV3 } from "./model.js";
import { allReportedResults, finalStatus } from "./result.js";

export function summarizeTestsV3(tests: readonly ReportedTestCaseV3[]): ReportSummaryV3 {
  const statuses = tests.map(finalStatus);
  const count = (status: TestStatus): number => statuses.filter((value) => value === status).length;
  const evidenceStatuses: readonly CaptureStatus[] = [
    "captured", "captureFailed", "unsupported", "notRequested",
  ];
  const artifacts = tests.flatMap((test) =>
    allReportedResults(test.attempts).flatMap((result) => result.artifacts));
  const evidence = Object.freeze(Object.fromEntries(evidenceStatuses.map((status) => [
    status,
    artifacts.filter((artifact) => artifact.captureStatus === status).length,
  ]))) as Readonly<Record<CaptureStatus, number>>;
  const passed = count("passed");
  const failed = count("failed");
  const timedOut = count("timedOut");
  const unsupported = count("unsupported");
  return Object.freeze({
    discovered: tests.length,
    executed: passed + failed + timedOut + unsupported,
    passed,
    failed,
    timedOut,
    skipped: count("skipped"),
    unsupported,
    evidence,
    attempts: tests.reduce((total, test) =>
      total + (test.attempts.state === "known" ? test.attempts.items.length : 0), 0),
    casesWithUnknownAttempts: tests.filter((test) => test.attempts.state === "unknown").length,
  });
}

export function overallStatusV3(summary: ReportSummaryV3): RunStatus {
  if (summary.failed > 0) return "failed";
  if (summary.timedOut > 0) return "timedOut";
  if (summary.unsupported > 0 || summary.skipped > 0) return "incomplete";
  return "passed";
}

export function testsForReviewV3(
  tests: readonly ReportedTestCaseV3[],
): readonly ReportedTestCaseV3[] {
  const rank: Readonly<Record<TestStatus, number>> = {
    failed: 0, timedOut: 1, unsupported: 2, skipped: 3, passed: 4,
  };
  return [...tests].sort((left, right) => rank[finalStatus(left)] - rank[finalStatus(right)]);
}
