import { readFileSync } from "node:fs";

import { defineFixture } from "@surfaceloom/core";
import { defineCaseV3, expectAgent } from "@surfaceloom/test";

import {
  ReferenceAgentBrowserAdapter,
  referenceAgentToolId,
  runBarrier,
} from "../adapter/reference-agent-browser.mjs";
import { startReferenceAgent } from "../src/index.mjs";
import { v3Session } from "../showcase/v3-browser-session.mjs";
import {
  assertDiagnosticLocalEffectCount,
  assertLocalEffectCount,
  assertNoToolExecution,
  settleCriteria,
  waitForCheckpoint,
} from "./assertions.mjs";
import { browserSurfaceId, evidenceArtifactId } from "./matrix.mjs";
import { observeFaultCase } from "./observe.mjs";

export function createFaultMatrixCase(entry) {
  const recovery = { app: null, runId: null, checkpoint: entry.checkpoint ?? null,
    cleanup: null, recovered: null };
  const appFixture = defineFixture({
    id: `reference-agent.p3-088.http.${entry.key}`,
    setup: async () => {
      const app = await startReferenceAgent();
      recovery.app = app;
      return { value: app, teardown: () => app.close({ timeoutMs: entry.cleanupUnconfirmed ? 60 : 1_000 }) };
    },
  });
  const spec = readSpec(entry.key);
  const definition = defineCaseV3({ spec, fixtures: [appFixture], run: async (context) => {
    const app = context.fixture(appFixture);
    const surface = context.surface(browserSurfaceId);
    if (surface.kind !== "browser") throw new Error("Expected the browser author surface.");
    const browser = new ReferenceAgentBrowserAdapter(v3Session(surface), app.baseUrl);
    const created = app.createRun({ fault: entry.fault });
    const { runId, callId } = created;
    recovery.runId = runId;
    if (entry.checkpoint !== undefined) app.pauseCheckpoint(runId, entry.checkpoint,
      entry.cleanupUnconfirmed ? { releaseOnCancel: false, releaseOnClose: false } : {});
    await browser.openRun(runId);
    const run = await browser.bindRun(runId);
    const tool = run.tool(referenceAgentToolId);
    const barrier = runBarrier(runId);

    await context.criterion("approval-requested", () =>
      expectAgent(run).toHaveRequestedApproval({ criterionId: "approval-requested" }));
    if (entry.checkpoint !== undefined) registerRunWork(context, app, runId, entry, recovery);
    const browserAction = { action: entry.decision, outcome: "succeeded" };
    await browser.decide(entry.decision);

    if (entry.checkpoint === undefined) {
      await terminalStatus(context, run, entry.decision === "deny" ? "denied" : "completed");
      const evidence = await submitObservation(context, { app, browser, runId, callId,
        browserAction });
      await normalCriteria(context, entry, browser, tool, runId, barrier);
      return evidence;
    }

    await waitForCheckpoint(app, runId, entry.checkpoint);
    if (entry.cleanupUnconfirmed) {
      await context.criterion("effect-recorded-before-cleanup", () =>
        assertDiagnosticLocalEffectCount(browser, runId, 1,
          "effect-recorded-before-cleanup"));
      await context.criterion("owned-work-registered", () => {
        if (recovery.cleanup?.registered !== true) throw new Error("Owned run-work was not registered.");
      });
      await submitObservation(context, { app, browser, runId, callId, browserAction });
      return;
    }

    const stopReceipt = app.stop(runId,
      { mode: entry.checkpoint === "after-effect" ? "emergency" : "stop" });
    const settleReceipt = await app.settle(runId, { timeoutMs: 1_000 });
    if (entry.checkpoint === "before-submit") {
      app.resumeCheckpoint(runId, entry.checkpoint);
      const repeated = app.stop(runId, { mode: "stop" });
      if (repeated !== stopReceipt) throw new Error("Repeated stop did not preserve its immutable receipt.");
      await app.settle(runId, { timeoutMs: 1_000 });
    }
    await terminalStatus(context, run,
      entry.checkpoint === "after-effect" ? "completed" : "cancelled");
    await submitObservation(context, { app, browser, runId, callId, browserAction,
      stopReceipt, settleReceipt });
    await stopCriteria(context, entry, browser, tool, runId, barrier,
      stopReceipt, settleReceipt, app);
  } });
  return Object.freeze({ definition, recovery, recover: () => recoverLateWork(recovery) });
}

async function normalCriteria(context, entry, browser, tool, runId, barrier) {
  const exact = () => expectAgent(tool).toHaveExecutedExactlyOnce({
    barrier, criterionId: entry.key.includes("ledger")
      ? "ledger-call-exactly-once" : "primary-call-exactly-once",
  });
  if (entry.key === "deny-but-execute") {
    await settleCriteria([
      context.criterion("zero-tool-execution", () =>
        assertNoToolExecution(browser, tool, barrier, "zero-tool-execution")),
      context.criterion("zero-business-effect", () =>
        assertLocalEffectCount(browser, runId, 0, barrier, "zero-business-effect")),
    ]);
  } else if (entry.key === "duplicate-business-effect") {
    await settleCriteria([
      context.criterion("primary-call-exactly-once", exact),
      context.criterion("business-effect-exactly-one", () =>
        assertLocalEffectCount(browser, runId, 1, barrier, "business-effect-exactly-one")),
    ]);
  } else {
    await settleCriteria([
      context.criterion("independent-effect-one", () =>
        assertDiagnosticLocalEffectCount(browser, runId, 1, "independent-effect-one")),
      context.criterion("ledger-call-exactly-once", exact),
    ]);
  }
}

async function stopCriteria(context, entry, browser, tool, runId, barrier,
  stopReceipt, settleReceipt, app) {
  if (entry.checkpoint === "before-submit") {
    await settleCriteria([
      context.criterion("stop-not-executed", () => receipt(stopReceipt, settleReceipt,
        { outcome: "notExecuted", submitted: false, effectObserved: false })),
      context.criterion("ledger-zero-execution", () =>
        assertNoToolExecution(browser, tool, barrier, "ledger-zero-execution")),
      context.criterion("effect-zero-stable", async () => {
        await assertLocalEffectCount(browser, runId, 0, barrier, "effect-zero-stable");
        if (app.readEffects(runId).length !== 0) throw new Error("A late effect appeared after settlement.");
      }),
    ]);
  } else if (entry.checkpoint === "after-submit") {
    await settleCriteria([
      context.criterion("stop-definitive-outcome", () => {
        if (stopReceipt.outcome === "unknown" && stopReceipt.submitted === true) {
          throw new Error("Submitted operation remained unknown after stop.");
        }
      }),
      context.criterion("ledger-call-exactly-once", () =>
        expectAgent(tool).toHaveExecutedExactlyOnce({
          barrier, criterionId: "ledger-call-exactly-once" })),
      context.criterion("effect-zero-proven", () =>
        assertLocalEffectCount(browser, runId, 0, barrier, "effect-zero-proven")),
    ]);
  } else {
    await settleCriteria([
      context.criterion("stop-executed", () => receipt(stopReceipt, settleReceipt,
        { outcome: "executed", submitted: true, effectObserved: true })),
      context.criterion("ledger-call-exactly-once", () =>
        expectAgent(tool).toHaveExecutedExactlyOnce({
          barrier, criterionId: "ledger-call-exactly-once" })),
      context.criterion("business-effect-exactly-one", () =>
        assertLocalEffectCount(browser, runId, 1, barrier, "business-effect-exactly-one")),
    ]);
  }
}

function registerRunWork(context, app, runId, entry, recovery) {
  const cleanup = { registered: true, calls: 0, stopReceipt: null, settleReceipt: null };
  recovery.cleanup = cleanup;
  context.registerResource({ id: `reference-agent.run-work.${runId}`, ownership: "owned",
    cleanup: async () => {
      cleanup.calls += 1;
      cleanup.stopReceipt = app.stop(runId, { mode: "stop" });
      cleanup.settleReceipt = await app.settle(runId,
        { timeoutMs: entry.cleanupUnconfirmed ? 30 : 500 });
      return cleanup.settleReceipt.settled
        ? { status: "released" }
        : { status: "unconfirmed", reason: "Run work did not settle before cleanup deadline." };
    } });
}

async function terminalStatus(context, run, expected) {
  const criterionId = expected === "denied" ? "ui-denied"
    : expected === "cancelled" ? "ui-cancelled" : "ui-completed";
  await context.criterion(criterionId, () =>
    expectAgent(run).toHaveRunState(expected, { criterionId }));
}

async function submitObservation(context, input) {
  const evidence = await observeFaultCase(input);
  context.evidence.submit({ id: `fault-matrix.${input.runId}`,
    artifactId: evidenceArtifactId,
    correlationId: `agent:${input.runId}:${input.callId}:append-note:reference-agent.local-note`,
    content: { kind: "probe", probeId: `fault-matrix.${input.runId}`,
      resource: "reference-agent.local-note", outcome: evidence.outcome, value: evidence.value },
    completeness: evidence.completeness });
  return evidence;
}

function receipt(actual, settlement, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw new Error(`Stop receipt ${key} was ${String(actual[key])}.`);
  }
  if (settlement.status !== "settled" || settlement.settled !== true) {
    throw new Error("Run work did not settle.");
  }
}

async function recoverLateWork(recovery) {
  if (!recovery.app || !recovery.runId || !recovery.checkpoint) return null;
  try { recovery.app.resumeCheckpoint(recovery.runId, recovery.checkpoint); } catch { /* already released */ }
  const settled = await recovery.app.settle(recovery.runId, { timeoutMs: 1_000 });
  recovery.recovered = Object.freeze({ settled, effects: recovery.app.readEffects(recovery.runId),
    ledger: recovery.app.readRawLedger(recovery.runId) });
  return recovery.recovered;
}

function readSpec(key) {
  return Object.freeze(JSON.parse(readFileSync(
    new URL(`./specs/${key}.case-spec.json`, import.meta.url), "utf8")));
}
