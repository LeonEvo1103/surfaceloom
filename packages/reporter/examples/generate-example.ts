import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeReportBundle, type SourceArtifact } from "../src/index.js";

const output = path.resolve(process.argv[2] ?? `artifacts/reporter-example-${Date.now()}`);
const source = await mkdtemp(path.join(os.tmpdir(), "surfaceloom-example-"));
const screenshot = path.join(source, "failure.png");
const trace = path.join(source, "events.jsonl");

try {
  await Promise.all([
    writeFile(screenshot, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    )),
    writeFile(trace, [
      JSON.stringify({ sequence: 1, kind: "operation.started", action: "window.close" }),
      JSON.stringify({ sequence: 2, kind: "operation.finished", outcome: "failed" }),
      "",
    ].join("\n")),
  ]);

  const evidence: SourceArtifact[] = [
    {
      id: "failure-screenshot",
      kind: "screenshot",
      phase: "failure",
      title: "失败截图",
      captureStatus: "captured",
      sourcePath: screenshot,
      contentType: "image/png",
      capturedAt: "2026-08-19T01:00:01.000Z",
      reviewPriority: "primary",
    },
    {
      id: "screen-recording",
      kind: "video",
      phase: "failure",
      title: "屏幕录制",
      captureStatus: "unsupported",
      captureError: "演示 runner 未配置录屏证据 provider。",
      contentType: "video/mp4",
      capturedAt: "2026-08-19T01:00:01.000Z",
    },
    {
      id: "semantic-trace",
      kind: "trace",
      phase: "after",
      title: "语义动作时间线",
      captureStatus: "captured",
      sourcePath: trace,
      contentType: "application/x-ndjson",
      capturedAt: "2026-08-19T01:00:02.000Z",
    },
  ];

  const result = await writeReportBundle({
    run: {
      id: "reporter-example",
      title: "SurfaceLoom 中文 Case 报告示例",
      platform: "macos",
      startedAt: "2026-08-19T01:00:00.000Z",
      finishedAt: "2026-08-19T01:00:02.000Z",
      app: { id: "fixture.desktop", name: "Fixture Desktop" },
      environment: { runnerName: "reporter-example", ci: false },
    },
    tests: [
      {
        spec: {
          id: "fixture.window.close",
          locale: "zh-CN",
          platforms: ["macos"],
          suite: { id: "app.lifecycle", name: "应用生命周期" },
          name: "Cmd+W 隐藏窗口但不退出应用",
          sourceName: "Close keeps the process alive",
          intent: "验证关闭主窗口仅隐藏界面，应用进程仍保持运行并可恢复会话。",
          preconditions: [
            { id: "main-window-visible", text: "应用已启动且唯一主窗口可见。" },
          ],
          acceptanceCriteria: [
            { id: "window-hidden", text: "主窗口变为不可见。" },
            { id: "process-alive", text: "应用进程仍保持运行。" },
          ],
          sideEffect: "reversible",
          tags: ["macos", "release-candidate"],
        },
        result: {
          status: "failed",
          startedAt: "2026-08-19T01:00:00.000Z",
          durationMs: 2000,
          steps: [
            {
              id: "close",
              title: "关闭主窗口",
              status: "passed",
              durationMs: 40,
              criterionIds: ["window-hidden"],
            },
            {
              id: "hidden",
              title: "等待窗口隐藏并确认进程状态",
              status: "timedOut",
              durationMs: 1960,
              criterionIds: ["window-hidden", "process-alive"],
            },
          ],
          error: { category: "timeout", message: "等待 2 秒后主窗口仍然可见。" },
          artifacts: evidence,
        },
      },
      {
        spec: {
          id: "fixture.permission.first-run",
          locale: "zh-CN",
          platforms: ["macos"],
          suite: { id: "system.permissions", name: "系统权限" },
          name: "首次授权流程只在可恢复环境执行",
          sourceName: "First-run authorization",
          intent: "验证系统授权流程时不污染开发者真实账户的 TCC 状态。",
          preconditions: [
            { id: "recoverable-vm", text: "专用测试用户或可恢复虚拟机已经就绪。" },
          ],
          acceptanceCriteria: [
            { id: "permission-flow-visible", text: "授权流程按产品约定呈现并可被判定。" },
          ],
          sideEffect: "securitySensitive",
        },
        result: {
          status: "skipped",
          reason: "当前环境不是可恢复虚拟机，未触发系统授权窗口。",
          startedAt: "2026-08-19T01:00:02.000Z",
          durationMs: 0,
          steps: [],
        },
      },
    ],
  }, output);

  process.stdout.write(
    `${result.completionMarkerPath}\n${result.htmlPath}\n${result.aiReviewPath}\n${result.reportPath}\n`,
  );
} finally {
  await rm(source, { recursive: true, force: true });
}
