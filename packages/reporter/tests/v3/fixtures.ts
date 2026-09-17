import type { ReportBundleV3Input } from "../../src/v3/index.js";

export function v3Input(finalAttemptId = "attempt-2"): ReportBundleV3Input {
  const startedAt = "2026-09-16T01:00:00.000Z";
  const result = (status: "passed" | "failed", durationMs: number) => ({
    status,
    startedAt,
    durationMs,
    steps: [{
      id: `verify-${status}`,
      title: status === "passed" ? "确认最终结果" : "记录首次失败",
      status,
      durationMs,
      criterionIds: ["verified"],
    }],
    ...(status === "failed" ? {
      error: { category: "assertion", message: "首次尝试失败" },
    } : {}),
  });
  return {
    run: {
      id: "run-v3",
      title: "Reporter v3 契约",
      startedAt,
      finishedAt: "2026-09-16T01:00:02.000Z",
      app: { id: "fixture.app", name: "Fixture App" },
      provenance: { kind: "native" },
      hosts: { state: "known", value: [
        { id: "remote-browser", os: "linux", name: "Remote browser host" },
        { id: "runner", os: "macos", name: "Runner host" },
      ] },
      surfaces: { state: "known", value: [
        { id: "native", kind: "desktop", hostId: { state: "known", value: "runner" } },
        { id: "page", kind: "browser", hostId: { state: "known", value: "remote-browser" },
          capabilities: ["browser.navigation", "browser.dom.inspect"] },
      ] },
    },
    tests: [{
      spec: {
        id: "case-v3",
        locale: "zh-CN",
        platforms: ["macos", "web"],
        suite: { id: "report.v3", name: "报告契约" },
        name: "跨 Host 的多 Surface 尝试",
        intent: "验证报告明确保留执行器、Surface 所在 Host 和重试边界。",
        preconditions: [],
        acceptanceCriteria: [{ id: "verified", text: "最终结果由明确的最终尝试决定。" }],
        sideEffect: "readOnly",
      },
      attempts: {
        state: "known",
        finalAttemptId,
        items: [{
          id: "attempt-2",
          ordinal: 2,
          executionPlatforms: ["macos", "web"],
          runnerHostId: { state: "known", value: "runner" },
          surfaceIds: { state: "known", value: ["native", "page"] },
          result: result("passed", 20),
        }, {
          id: "attempt-1",
          ordinal: 1,
          executionPlatforms: ["web", "macos"],
          runnerHostId: { state: "known", value: "runner" },
          surfaceIds: { state: "known", value: ["page", "native"] },
          result: result("failed", 10),
        }],
      },
    }],
  };
}
