import type {
  CompletedRunResult,
  ExecutionLinks,
  RunStatus,
} from "../../dist/index.js";

declare const base: Omit<CompletedRunResult, "executionStatus" | "outcome" | "reason">;

const failedStatus: RunStatus = "failed";
const links: ExecutionLinks = {
  caseSpecs: [{ namespace: "case-spec", caseSpecId: "case.one" }],
  agentRuns: [{ namespace: "agent", agentRunId: "agent-run", agentCallIds: ["call"] }],
  nativeOperations: [{ namespace: "native", nativeOperationId: "native-operation" }],
};
const skipped: CompletedRunResult = {
  ...base,
  executionStatus: "completed",
  outcome: "skipped",
  reason: "Fixture is unavailable.",
};
const passed: CompletedRunResult = {
  ...base,
  executionStatus: "completed",
  outcome: "passed",
};
const failed: CompletedRunResult = {
  ...base,
  executionStatus: "completed",
  outcome: "failed",
  reason: "A business criterion failed.",
};
const unknown: CompletedRunResult = {
  ...base,
  executionStatus: "completed",
  outcome: "unknown",
  reason: "Required evidence was incomplete.",
};

// @ts-expect-error skipped outcomes require a reason.
const skippedWithoutReason: CompletedRunResult = {
  ...base,
  executionStatus: "completed",
  outcome: "skipped",
};

// @ts-expect-error unsupported outcomes require a reason.
const unsupportedWithoutReason: CompletedRunResult = {
  ...base,
  executionStatus: "completed",
  outcome: "unsupported",
};

// @ts-expect-error failed outcomes require a business reason.
const failedWithoutReason: CompletedRunResult = {
  ...base,
  executionStatus: "completed",
  outcome: "failed",
};

// @ts-expect-error unknown outcomes require an evidence reason.
const unknownWithoutReason: CompletedRunResult = {
  ...base,
  executionStatus: "completed",
  outcome: "unknown",
};

// @ts-expect-error passed outcomes cannot carry a failure reason.
const passedWithReason: CompletedRunResult = {
  ...base,
  executionStatus: "completed",
  outcome: "passed",
  reason: "contradiction",
};

void [
  failedStatus, links, skipped, passed, failed, unknown, skippedWithoutReason,
  unsupportedWithoutReason, failedWithoutReason, unknownWithoutReason, passedWithReason,
];
