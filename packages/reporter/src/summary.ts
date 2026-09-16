import type {
  CaptureStatus,
  CaseReportInput,
  ReportSummary,
  ReportedTestCase,
  RunStatus,
  TestStatus,
} from "./model.js";

export function summarizeTests(
  tests: readonly CaseReportInput[] | readonly ReportedTestCase[],
): ReportSummary {
  const count = (status: TestStatus): number =>
    tests.filter((test) => test.result.status === status).length;
  const evidenceStatuses: readonly CaptureStatus[] = [
    "captured",
    "captureFailed",
    "unsupported",
    "notRequested",
  ];
  const artifacts = tests.flatMap((test) => test.result.artifacts ?? []);
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
  });
}

export function overallStatus(summary: ReportSummary): RunStatus {
  if (summary.failed > 0) return "failed";
  if (summary.timedOut > 0) return "timedOut";
  if (summary.unsupported > 0 || summary.skipped > 0) return "incomplete";
  return "passed";
}

export function testsForReview(
  tests: readonly ReportedTestCase[],
): readonly ReportedTestCase[] {
  const rank: Readonly<Record<TestStatus, number>> = {
    failed: 0,
    timedOut: 1,
    unsupported: 2,
    skipped: 3,
    passed: 4,
  };
  return [...tests].sort(
    (left, right) => rank[left.result.status] - rank[right.result.status],
  );
}
