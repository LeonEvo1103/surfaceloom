import type { NormalizedCaseReportInput, TestErrorSummary } from "@surfaceloom/reporter";

import { errorSummary } from "./errors.js";

export type RunCaseV3FailurePhase = "kernelStop" | "surfaceAcquisition" | "evidence"
  | "materialization" | "adaptation" | "publication";

export interface RunCaseV3AdditionalFailure {
  readonly phase: RunCaseV3FailurePhase;
  readonly category: string;
  readonly message: string;
}

/** Additive runner failure; an existing kernel error remains the primary cause. */
export class RunCaseV3Error extends Error {
  readonly report: NormalizedCaseReportInput;
  readonly primaryCause: TestErrorSummary | undefined;
  readonly additionalFailure: RunCaseV3AdditionalFailure;

  constructor(report: NormalizedCaseReportInput, phase: RunCaseV3FailurePhase, cause: unknown) {
    const additional = errorSummary(`runnerV3.${phase}`, cause);
    super(additional.message);
    this.name = "RunCaseV3Error";
    this.report = report;
    this.primaryCause = report.result.error;
    this.additionalFailure = Object.freeze({ phase, category: additional.category,
      message: additional.message });
    Object.freeze(this);
  }
}
