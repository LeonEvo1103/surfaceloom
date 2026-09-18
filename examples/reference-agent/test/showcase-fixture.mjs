import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { writeReportV3Bundle } from "@surfaceloom/reporter";

import {
  browserHostId, browserSurfaceId, runnerHostId, showcaseCases, showcaseRun,
} from "../showcase/matrix.mjs";

export async function createSyntheticChildren(root, { crossRun = false } = {}) {
  const reportRunId = `reference-agent.m1.${randomUUID()}`;
  const children = [];
  for (const entry of showcaseCases) {
    const directory = path.join(root, entry.key);
    const source = path.join(root, "source", entry.key);
    await mkdir(source, { recursive: true });
    const childRunId = crossRun && entry.key === "approve"
      ? `reference-agent.m1.${randomUUID()}` : reportRunId;
    const bundle = await writeReportV3Bundle({ run: run(childRunId),
      tests: [reportCase(entry, [await artifact(source, entry)])] }, directory);
    children.push(Object.freeze({ caseId: entry.id, directory, reportRunId, bundle }));
  }
  return Object.freeze({ children: Object.freeze(children), reportRunId });
}

function run(id) {
  return {
    id, title: showcaseRun.title, startedAt: "2026-09-18T01:00:00.000Z",
    finishedAt: "2026-09-18T01:00:01.000Z", app: showcaseRun.app,
    provenance: { kind: "native" },
    hosts: { state: "known", value: [
      { id: runnerHostId, os: "macos", name: "SurfaceLoom runner" },
      { id: browserHostId, os: "macos", name: "Owned Playwright browser" },
    ] },
    surfaces: { state: "known", value: [{ id: browserSurfaceId, kind: "browser",
      hostId: { state: "known", value: browserHostId },
      capabilities: ["browser.navigate", "browser.dom.inspect", "browser.dom.invoke"] }] },
  };
}

function reportCase(entry, artifacts) {
  const status = entry.expectedStatus;
  return { spec: {
    id: entry.id, locale: "zh-CN", platforms: ["web"],
    suite: { id: "reference-agent.m1", name: "参考智能体 M1 验证矩阵" },
    name: "合成聚合验收", intent: "验证一键聚合严格保留业务红绿结果与证据。",
    preconditions: [], acceptanceCriteria: [
      { id: "approval-requested", text: "审批已请求。" },
      { id: "ui-status", text: "UI 状态正确。" },
      { id: "tool-lifecycle", text: "工具生命周期正确。" },
      { id: "local-effect", text: "本地副作用正确。" },
    ],
    sideEffect: "externalEffect",
  }, attempts: { state: "known", finalAttemptId: "attempt-1", items: [{
    id: "attempt-1", ordinal: 1, executionPlatforms: ["web"],
    runnerHostId: { state: "known", value: runnerHostId },
    surfaceIds: { state: "known", value: [browserSurfaceId] },
    result: { status, startedAt: "2026-09-18T01:00:00.000Z", durationMs: 5,
      steps: [...businessSteps(status), ...lifecycleSteps()], artifacts,
      ...(status === "failed" ? { error: { category: "criterion", message: "预期业务故障" } } : {}) },
  }] } };
}

function businessSteps(status) {
  if (status === "passed") {
    return ["approval-requested", "ui-status", "tool-lifecycle", "local-effect"].map(
      (criterionId, index) => ({ id: `kernel.criterion.${index + 1}`, title: criterionId,
        status: "passed", durationMs: 1, criterionIds: [criterionId] }),
    );
  }
  const criterion = { id: "kernel.criterion.1", title: "验证工具生命周期", status: "failed",
    durationMs: 1, criterionIds: ["tool-lifecycle"] };
  return [criterion,
    { id: "kernel.body.2", title: "Case body", status: "failed", durationMs: 1 }];
}

function lifecycleSteps() {
  return [
    { id: "kernel.execution", title: "Execution producer settled", status: "passed", durationMs: 0,
      diagnostic: executionDiagnostic() },
    { id: "kernel.cleanup", title: "Cleanup receipts", status: "passed", durationMs: 0,
      diagnostic: cleanupDiagnostic() },
  ];
}

function executionDiagnostic() {
  return JSON.stringify({ schemaVersion: "surfaceloom.execution-diagnostic/v1", data: { worker: {
    state: "settled", tainted: false, cancellationRequested: false,
    settlement: { status: "fulfilled" }, failures: [],
  } } });
}

function cleanupDiagnostic() {
  return JSON.stringify({ schemaVersion: "surfaceloom.execution-diagnostic/v1", data: { cleanup: {
    state: "closed", status: "passed", tainted: false, outcomes: [
      { id: "surface.browser.session.approval-ui", ownership: "owned", status: "released" },
    ], remaining: [], failures: [],
  } } });
}

async function artifact(directory, entry) {
  const sourcePath = path.join(directory, "evidence.json");
  await writeFile(sourcePath, `${JSON.stringify({ caseId: entry.id, outcome: "observed" })}\n`);
  return { id: "case.evidence", kind: "diagnostics", phase: "after",
    title: "Case evidence", captureStatus: "captured", sourcePath,
    contentType: "application/json", capturedAt: "2026-09-18T01:00:00.000Z",
    reviewPriority: "primary" };
}
