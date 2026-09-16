import type {
  CaseExecutionResultInput,
  ReportedCaseExecutionResult,
  TestStatus,
} from "../model.js";
import type {
  AttemptsV3Input,
  ReportedAttemptsV3,
  ReportedTestCaseV3,
} from "./model.js";

export function finalInputResult(attempts: AttemptsV3Input): CaseExecutionResultInput {
  if (attempts.state === "unknown") return attempts.result;
  return attempts.items.find((attempt) => attempt.id === attempts.finalAttemptId)!.result;
}

export function finalReportedResult(attempts: ReportedAttemptsV3): ReportedCaseExecutionResult {
  if (attempts.state === "unknown") return attempts.result;
  return attempts.items.find((attempt) => attempt.id === attempts.finalAttemptId)!.result;
}

export function finalStatus(test: ReportedTestCaseV3): TestStatus {
  return finalReportedResult(test.attempts).status;
}

export function allReportedResults(
  attempts: ReportedAttemptsV3,
): readonly ReportedCaseExecutionResult[] {
  return attempts.state === "unknown"
    ? [attempts.result]
    : attempts.items.map((attempt) => attempt.result);
}
