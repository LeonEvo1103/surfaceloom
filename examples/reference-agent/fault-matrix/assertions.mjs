import { assertObservation } from "@surfaceloom/test";

import { referenceAgentLocalResource } from "../adapter/reference-agent-browser.mjs";

export function assertNoToolExecution(provider, tool, barrier, criterionId) {
  return assertObservation((readContext) => provider.readToolCall({ runId: tool.runId,
    callId: tool.callId }, readContext), { expectation: { kind: "negative-value",
      expected: { runId: tool.runId, callId: tool.callId, requested: 1, started: 0, completed: 0 },
      matches: (value) => value.runId === tool.runId && value.callId === tool.callId
        && value.requested === 1 && value.started === 0 && value.completed === 0,
      completeness: barrier }, timeoutMs: 220, pollIntervalMs: 20, criterionId });
}

export function assertLocalEffectCount(provider, runId, count, barrier, criterionId) {
  return assertObservation((readContext) => provider.readLocalEffects({ runId,
    resource: referenceAgentLocalResource }, readContext), { expectation: {
      kind: "negative-value",
      expected: { runId, resource: referenceAgentLocalResource, boundary: "local", count },
      matches: (value) => value.runId === runId
        && value.resource === referenceAgentLocalResource && value.boundary === "local"
        && value.count === count,
      completeness: barrier }, timeoutMs: 220,
    pollIntervalMs: 20, criterionId });
}

export function assertDiagnosticLocalEffectCount(provider, runId, count, criterionId) {
  return assertObservation((readContext) => provider.readRawLocalEffects({ runId,
    resource: referenceAgentLocalResource }, readContext), { expectation: {
      kind: "value",
      expected: { runId, resource: referenceAgentLocalResource, boundary: "local", count },
      matches: (value) => value.runId === runId
        && value.resource === referenceAgentLocalResource && value.boundary === "local"
        && value.count === count }, timeoutMs: 220, pollIntervalMs: 20, criterionId });
}

export async function settleCriteria(criteria) {
  const settled = await Promise.allSettled(criteria);
  const failures = settled.filter((item) => item.status === "rejected").map((item) => item.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Multiple fault-matrix criteria failed.");
  return settled.map((item) => item.value);
}

export async function waitForCheckpoint(app, runId, checkpoint, timeoutMs = 1_000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const snapshot = app.readCheckpoint(runId, checkpoint);
    if (snapshot.reached && snapshot.waiting) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < deadline);
  throw new Error(`Checkpoint ${checkpoint} was not reached before the deadline.`);
}
