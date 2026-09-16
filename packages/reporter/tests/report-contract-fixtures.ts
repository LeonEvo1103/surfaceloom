import type { NormalizedReportBundleInput, SourceArtifact } from "../src/index.js";

export const screenshot: SourceArtifact = {
  id: "shot",
  kind: "screenshot",
  phase: "after",
  title: "After",
  captureStatus: "captured",
  sourcePath: "/tmp/after.png",
  contentType: "image/png",
  capturedAt: "2026-08-19T01:00:00.000Z",
};

const { sourcePath: _sourcePath, ...withoutSource } = screenshot;
export const screenshotWithoutSource = withoutSource;

export function stubTest(
  status: "passed" | "skipped" | "unsupported",
): NormalizedReportBundleInput["tests"][number] {
  return {
    spec: {
      id: `case-${status}`,
      locale: "zh-CN",
      platforms: ["macos", "windows"],
      suite: { id: "report.contract", name: "报告契约" },
      name: `状态结果明确：${status}`,
      intent: "验证报告不会把未执行或不支持状态误计为通过。",
      preconditions: [],
      acceptanceCriteria: [
        { id: "result-explicit", text: "结果状态被明确记录。" },
      ],
      sideEffect: "readOnly",
    },
    result: {
      status,
      startedAt: "2026-08-19T01:00:00.000Z",
      durationMs: 1,
      steps: status === "passed"
        ? [{
            id: "assert-result",
            title: "确认结果状态明确",
            status: "passed",
            durationMs: 1,
            criterionIds: ["result-explicit"],
          }]
        : [],
      ...(status === "skipped" || status === "unsupported"
        ? { reason: "该状态用于契约验证。" }
        : {}),
    },
  };
}
