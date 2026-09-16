import type {
  NormalizedReportBundleInput,
  ReportBundleResult,
  ReportSummary,
  RunStatus,
  WriteReportOptions,
} from "@surfaceloom/reporter";

export const suiteExitCodes = Object.freeze({
  passed: 0,
  testFailure: 1,
  cliError: 2,
} as const);

export type SuiteExitCode = (typeof suiteExitCodes)[keyof typeof suiteExitCodes];

/** Validated, in-memory report state produced before optional bundle writing. */
export interface SuiteReportSnapshot {
  readonly input: NormalizedReportBundleInput;
  readonly status: RunStatus;
  readonly summary: ReportSummary;
  readonly exitCode: 0 | 1;
}

export interface WrittenSuiteReport extends SuiteReportSnapshot {
  readonly bundle: ReportBundleResult;
}

export interface SuiteReportWriteOptions extends WriteReportOptions {}
