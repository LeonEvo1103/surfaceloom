import assert from "node:assert/strict";

import { defineFixture } from "@surfaceloom/core";
import {
  assertObservation,
  defineCaseV3,
  expectAgent,
} from "@surfaceloom/test";

import {
  ReferenceAgentBrowserAdapter,
  referenceAgentLocalResource,
  referenceAgentToolId,
  runBarrier,
} from "../adapter/reference-agent-browser.mjs";
import { startReferenceAgent } from "../src/index.mjs";
import { browserSurfaceId, probeArtifactId, probeCorrelation } from "./matrix.mjs";
import { settleProbeReads } from "./probe-settlement.mjs";
import { v3Session } from "./v3-browser-session.mjs";

export function createShowcaseCase(entry) {
  const appFixture = defineFixture({
    id: `reference-agent.http.${entry.key}`,
    setup: async () => {
      const app = await startReferenceAgent();
      return { value: app, teardown: () => app.close() };
    },
  });
  const spec = caseSpec(entry);
  return defineCaseV3({ spec, fixtures: [appFixture], run: async (context) => {
    const app = context.fixture(appFixture);
    const surface = context.surface(browserSurfaceId);
    if (surface.kind !== "browser") throw new Error("Expected the browser author surface.");
    const browser = new ReferenceAgentBrowserAdapter(v3Session(surface), app.baseUrl);
    const runId = entry.fault === "none"
      ? await openFreshRun(browser)
      : await openFaultRun(app, browser, entry.fault);
    const run = await browser.bindRun(runId);
    const tool = run.tool(referenceAgentToolId);
    const barrier = runBarrier(runId);

    await context.criterion("approval-requested", () =>
      expectAgent(run).toHaveRequestedApproval({ criterionId: "approval-requested" }));
    await browser.decide(entry.decision);
    await context.criterion("ui-status", () =>
      expectAgent(run).toHaveRunState(entry.decision === "approve" ? "completed" : "denied",
        { criterionId: "ui-status" }));

    const evidence = await observe(browser, runId, tool.callId, entry);
    context.evidence.submit({
      id: `agent-probe.${entry.key}`,
      artifactId: probeArtifactId,
      correlationId: probeCorrelation(runId, tool.callId),
      content: { kind: "probe", probeId: `agent-probe.${entry.key}`,
        resource: referenceAgentLocalResource, outcome: evidence.outcome, value: evidence.value },
      completeness: evidence.completeness,
    });

    await settleCriteria([
      context.criterion("tool-lifecycle", () => entry.expectedToolCount === 1
        ? expectAgent(tool).toHaveExecutedExactlyOnce({ barrier, criterionId: "tool-lifecycle" })
        : assertNoToolExecution(browser, tool, barrier)),
      context.criterion("local-effect", () =>
        assertLocalEffectCount(browser, runId, entry.expectedEffectCount, barrier)),
    ]);
  } });
}

function caseSpec(entry) {
  return Object.freeze({
    id: entry.id, locale: "zh-CN", platforms: ["web"],
    suite: { id: "reference-agent.m1", name: "参考智能体 M1 验证矩阵" },
    name: caseName(entry.key),
    intent: "通过真实浏览器验证审批 UI、精确工具生命周期、本地资源实际变化、证据完整性与清理。",
    preconditions: [{ id: "fixture-ready", text: "确定性参考智能体和独立工具账本已启动。" }],
    acceptanceCriteria: [
      { id: "approval-requested", text: "决定前精确运行与调用已请求审批。" },
      { id: "ui-status", text: "浏览器 UI 显示与决定一致的最终运行状态。" },
      { id: "tool-lifecycle", text: "完整边界内指定工具调用次数符合审批规则。" },
      { id: "local-effect", text: "独立本地资源探针记录的实际变化符合审批规则。" },
    ],
    sideEffect: "externalEffect",
    tags: ["agent", "approval", "browser", "m1", entry.key],
  });
}

function caseName(key) {
  return ({ deny: "拒绝后零执行", approve: "批准后恰好执行一次",
    "deny-but-execute": "拒绝却执行必须失败",
    "incomplete-ledger": "账本不完整必须失败" })[key];
}

async function openFreshRun(browser) {
  await browser.openHome();
  return browser.startRun();
}

async function openFaultRun(app, browser, fault) {
  const { runId } = app.createRun({ fault });
  await browser.openRun(runId);
  return runId;
}

async function observe(browser, runId, callId, entry) {
  const [ui, approval, tool, local] = await settleProbeReads([
    browser.readRunState({ runId }), browser.readApproval({ runId, callId }),
    browser.readToolCall({ runId, callId }),
    browser.readLocalEffects({ runId, resource: referenceAgentLocalResource }),
  ]);
  const completeness = providerCompleteness(tool, local);
  return Object.freeze({ outcome: completeness.state === "complete" ? "observed" : "unknown",
    completeness, value: Object.freeze({
    criteria: ["approval-requested", "ui-status", "tool-lifecycle", "local-effect"],
    expected: { decision: entry.decision, toolCount: entry.expectedToolCount,
      localEffectCount: entry.expectedEffectCount },
    ui: observed(ui), approval: observed(approval),
    identity: { runId, callId, toolId: referenceAgentToolId },
    tool: observed(tool), ledgerObservation: observed(tool),
    localProbe: { resource: referenceAgentLocalResource, boundary: "local",
      observed: observed(local) }, completeness,
    browserAction: { action: entry.decision, outcome: "succeeded" },
  }) });
}

function providerCompleteness(tool, local) {
  const complete = [tool, local].every((item) => item.state === "available"
    && item.completeness?.kind === "barrier" && item.completeness.complete === true);
  return complete ? Object.freeze({ state: "complete" })
    : Object.freeze({ state: "incomplete", reasons: ["producerDeclaredIncomplete"] });
}

function observed(value) {
  return value.state === "available"
    ? { state: "available", value: value.value, completeness: value.completeness ?? null }
    : { state: value.state, reason: value.reason };
}

async function settleCriteria(criteria) {
  const settled = await Promise.allSettled(criteria);
  const failures = settled.filter((item) => item.status === "rejected").map((item) => item.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Multiple acceptance criteria failed.");
}

function assertNoToolExecution(provider, tool, barrier) {
  return assertObservation((readContext) => provider.readToolCall({ runId: tool.runId,
    callId: tool.callId }, readContext), { expectation: { kind: "negative-value",
      expected: { runId: tool.runId, callId: tool.callId, requested: 1, started: 0, completed: 0 },
      matches: (value) => value.runId === tool.runId && value.callId === tool.callId
        && value.requested === 1 && value.started === 0 && value.completed === 0,
      completeness: barrier }, timeoutMs: 300, pollIntervalMs: 25,
    criterionId: "tool-lifecycle" });
}

function assertLocalEffectCount(provider, runId, count, barrier) {
  return assertObservation((readContext) => provider.readLocalEffects({ runId,
    resource: referenceAgentLocalResource }, readContext), { expectation: {
      kind: "negative-value", expected: { runId, resource: referenceAgentLocalResource,
        boundary: "local", count }, matches: (value) => value.runId === runId
        && value.resource === referenceAgentLocalResource && value.boundary === "local"
        && value.count === count, completeness: barrier }, timeoutMs: 300,
    pollIntervalMs: 25, criterionId: "local-effect" });
}
