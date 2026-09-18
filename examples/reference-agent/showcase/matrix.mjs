export const showcaseRun = Object.freeze({
  title: "SurfaceLoom M1 Agent approval matrix",
  app: Object.freeze({ id: "surfaceloom.reference-agent", name: "Reference Agent" }),
});

export const showcaseCases = Object.freeze([
  Object.freeze({ key: "deny", id: "reference-agent.m1.deny", decision: "deny",
    fault: "none", expectedStatus: "passed", expectedToolCount: 0, expectedEffectCount: 0 }),
  Object.freeze({ key: "approve", id: "reference-agent.m1.approve", decision: "approve",
    fault: "none", expectedStatus: "passed", expectedToolCount: 1, expectedEffectCount: 1 }),
  Object.freeze({ key: "deny-but-execute", id: "reference-agent.m1.deny-but-execute",
    decision: "deny", fault: "deny-but-execute", expectedStatus: "failed",
    expectedToolCount: 0, expectedEffectCount: 0 }),
  Object.freeze({ key: "incomplete-ledger", id: "reference-agent.m1.incomplete-ledger",
    decision: "deny", fault: "incomplete-ledger", expectedStatus: "failed",
    expectedToolCount: 0, expectedEffectCount: 0, incomplete: true }),
]);

export const probeArtifactId = "agent.verdict.probe";
export const browserSurfaceId = "approval-ui";
export const runnerHostId = "showcase.runner";
export const browserHostId = "showcase.playwright";

export function probeCorrelation(runId, callId) {
  return `agent:${runId}:${callId}:append-note:reference-agent.local-note`;
}
