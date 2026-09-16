import assert from "node:assert/strict";
import type { CaseSpec } from "@surfaceloom/core";
import { validateReportInput, type CaseReportInput } from "@surfaceloom/reporter";

export function spec(id = "kernel.case"): CaseSpec {
  return {
    id, locale: "zh-CN", platforms: ["web"],
    suite: { id: "kernel.contract", name: "执行内核契约" },
    name: "完整记录用例生命周期",
    intent: "验证用例的验收与清理结果能够可靠地进入报告。",
    preconditions: [],
    acceptanceCriteria: [{ id: "verified", text: "观察结果符合预期。" }],
    sideEffect: "readOnly",
  };
}

export function validReport(report: CaseReportInput): void {
  assert.doesNotThrow(() => validateReportInput({
    run: {
      id: "test-run", title: "内核契约结果", platform: "web",
      startedAt: report.result.startedAt,
      finishedAt: new Date(Date.parse(report.result.startedAt) + report.result.durationMs).toISOString(),
      app: { id: "contract-fixture", name: "契约测试" },
    },
    tests: [JSON.parse(JSON.stringify(report)) as CaseReportInput],
  }));
}

export function diagnostics(report: CaseReportInput): string {
  return report.result.steps.map((step) => step.diagnostic ?? "").join("\n");
}
