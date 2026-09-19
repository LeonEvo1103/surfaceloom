import { referenceAgentLocalResource, referenceAgentToolId } from "../adapter/reference-agent-browser.mjs";
import { settleProbeReads } from "../showcase/probe-settlement.mjs";

export async function observeFaultCase({ app, browser, runId, callId, browserAction,
  stopReceipt = null, settleReceipt = null }) {
  const [ui, approval, tool, local, diagnosticLocal, ledgerOutlet] = await settleProbeReads([
    browser.readRunState({ runId }),
    browser.readApproval({ runId, callId }),
    browser.readToolCall({ runId, callId }),
    browser.readLocalEffects({ runId, resource: referenceAgentLocalResource }),
    browser.readRawLocalEffects({ runId, resource: referenceAgentLocalResource }),
    browser.readRawLedger(runId),
  ]);
  const reason = completenessReason(ledgerOutlet, tool, local);
  const completeness = reason === null ? { state: "complete" }
    : { state: "incomplete", reasons: ["producerDeclaredIncomplete"] };
  return Object.freeze({
    outcome: completeness.state === "complete" ? "observed" : "unknown",
    completeness: Object.freeze(completeness),
    value: Object.freeze({
      identity: { runId, callIds: callIds(app.readRawLedger(runId)),
        primaryCallId: callId, toolId: referenceAgentToolId,
        logicalOperationId: `${runId}:append-note:approved-note` },
      browserAction,
      businessOutcome: { run: app.getRun(runId), stopReceipt, settleReceipt },
      ui: observed(ui), approval: observed(approval), tool: observed(tool),
      ledgerObservation: observed(ledgerOutlet),
      ledgerCompleteness: { state: reason === null ? "complete" : "incomplete",
        reason: reason ?? "runBoundaryClosed" },
      diagnosticRawLedger: { authority: "diagnostic-only", value: app.readRawLedger(runId) },
      localProbe: { resource: referenceAgentLocalResource, boundary: "local", observed: observed(local),
        diagnostic: observed(diagnosticLocal), rawEffects: diagnosticLocal.state === "available"
          ? diagnosticLocal.value.effects : [] },
      checkpoint: checkpointSnapshot(app, runId),
    }),
  });
}

function completenessReason(ledger, tool, local) {
  if (ledger.state === "read-failed") return "ledgerReadFailed";
  if (ledger.state === "available" && ledger.value.complete === true
      && ledger.value.endBoundary?.lastSequence !== ledger.value.events?.length) {
    return "ledgerTruncatedEventInterval";
  }
  if (tool.state !== "available") return "ledgerUnclosedOrInvalid";
  if (local.completeness?.complete !== true) return "resourceIntervalUnclosed";
  return null;
}

function observed(value) {
  if (value.state === "available") return { state: "available", value: value.value,
    completeness: value.completeness ?? null };
  if (value.state === "read-failed") return { state: "read-failed", error: value.error };
  return { state: value.state, reason: value.reason };
}

function callIds(ledger) {
  return [...new Set(ledger.events.map((event) => event.callId))];
}

function checkpointSnapshot(app, runId) {
  return Object.fromEntries(["before-submit", "after-submit", "after-effect"]
    .map((checkpoint) => [checkpoint, app.readCheckpoint(runId, checkpoint)]));
}
