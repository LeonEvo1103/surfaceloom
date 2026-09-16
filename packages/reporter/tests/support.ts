import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ReportBundleInput } from "../src/index.js";

export async function createFixture(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "surfaceloom-report-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export function makeInput(
  paths: { screenshot: string; video: string; trace: string },
): ReportBundleInput {
  const startedAt = "2026-08-19T01:00:00.000Z";
  const artifact = (
    id: string,
    kind: "screenshot" | "video" | "trace",
    sourcePath: string,
    contentType: string,
  ) => ({
    id,
    kind,
    phase: kind === "trace" ? "after" as const : "failure" as const,
    title: `${kind} evidence`,
    captureStatus: "captured" as const,
    sourcePath,
    contentType,
    capturedAt: "2026-08-19T01:00:01.000Z",
    reviewPriority: "primary" as const,
  });
  return {
    run: {
      id: "run-001",
      title: "Reporter 报告契约",
      platform: "macos",
      startedAt,
      finishedAt: "2026-08-19T01:00:02.000Z",
      app: { id: "fixture.desktop", name: "Fixture Desktop" },
    },
    tests: [
      {
        spec: {
          id: "case-window-roundtrip",
          locale: "zh-CN",
          platforms: ["macos"],
          suite: { id: "window.lifecycle", name: "窗口生命周期" },
          name: "窗口 <script>alert(1)</script> 关闭后可恢复",
          sourceName: "Window closes and can be restored",
          intent: "验证关闭主窗口只改变窗口可见性，不会意外结束应用进程。",
          preconditions: [
            { id: "window-visible", text: "应用已启动且主窗口可见。" },
          ],
          acceptanceCriteria: [
            { id: "window-hidden", text: "主窗口变为不可见。" },
            { id: "process-alive", text: "应用进程保持运行。" },
          ],
          sideEffect: "reversible",
          tags: ["窗口"],
        },
        result: {
          status: "failed",
          startedAt,
          durationMs: 1200,
          steps: [
            {
              id: "close",
              title: "关闭主窗口",
              status: "passed",
              durationMs: 30,
              action: "window.close",
              criterionIds: ["window-hidden"],
            },
            {
              id: "hidden",
              title: "确认窗口隐藏且进程存活",
              status: "failed",
              durationMs: 1170,
              assertion: "窗口隐藏且应用进程存活",
              diagnostic: "窗口仍然可见",
              criterionIds: ["window-hidden", "process-alive"],
            },
          ],
          error: {
            category: "assertion",
            message: "Authorization: private-token\nat /Users/fixture-user/Documents/private.txt",
          },
          artifacts: [
            artifact("failure", "screenshot", paths.screenshot, "image/png"),
            artifact("video", "video", paths.video, "video/webm"),
            artifact("trace", "trace", paths.trace, "application/x-ndjson"),
          ],
        },
      },
      {
        spec: {
          id: "case-skipped",
          locale: "zh-CN",
          platforms: ["macos"],
          suite: { id: "system.permissions", name: "系统权限" },
          name: "首次授权流程仅在专用环境执行",
          intent: "避免在开发者真实账户中改变不可安全回滚的系统授权状态。",
          preconditions: [],
          acceptanceCriteria: [
            { id: "dedicated-user", text: "专用测试用户或可恢复虚拟机已经就绪。" },
          ],
          sideEffect: "securitySensitive",
        },
        result: {
          status: "skipped",
          reason: "当前运行环境不是专用测试用户或可恢复虚拟机。",
          startedAt,
          durationMs: 0,
          steps: [],
        },
      },
    ],
  };
}

export function asPassing(
  testCase: ReportBundleInput["tests"][number],
): ReportBundleInput["tests"][number] {
  const { error: _error, reason: _reason, ...resultWithoutOutcome } = testCase.result;
  return {
    ...testCase,
    result: {
      ...resultWithoutOutcome,
      status: "passed",
      steps: testCase.result.steps.map((step) => ({ ...step, status: "passed" })),
    },
  };
}

export function pngEvidence(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAE/wJ/l4jvWQAAAABJRU5ErkJggg==",
    "base64",
  );
}

export function webmEvidence(): Buffer {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00]);
}

export function mp4Evidence(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6d, 0x00, 0x00, 0x02, 0x00,
  ]);
}
