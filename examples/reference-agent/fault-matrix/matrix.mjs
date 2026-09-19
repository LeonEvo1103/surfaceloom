export const faultMatrixRun = Object.freeze({
  title: "SurfaceLoom P3-088 fault matrix",
  app: Object.freeze({ id: "surfaceloom.reference-agent", name: "Reference Agent" }),
});

export const faultMatrixCases = Object.freeze([
  entry("deny-but-execute", "failed", { decision: "deny", fault: "deny-but-execute" }),
  entry("duplicate-business-effect", "failed",
    { decision: "approve", fault: "duplicate-business-effect" }),
  entry("missing-ledger", "failed", { decision: "approve", fault: "missing-ledger",
    incompleteEvidence: true }),
  entry("truncated-ledger", "failed", { decision: "approve", fault: "truncated-ledger",
    incompleteEvidence: true }),
  entry("stop-before-submit", "passed", { decision: "approve", fault: "none",
    checkpoint: "before-submit" }),
  entry("stop-after-submit", "failed", { decision: "approve", fault: "none",
    checkpoint: "after-submit", incompleteEvidence: true }),
  entry("stop-after-effect", "passed", { decision: "approve", fault: "none",
    checkpoint: "after-effect" }),
  entry("cleanup-unconfirmed", "failed", { decision: "approve", fault: "none",
    checkpoint: "after-effect", cleanupUnconfirmed: true, incompleteEvidence: true }),
]);

export const browserSurfaceId = "approval-ui";
export const runnerHostId = "fault-matrix.runner";
export const browserHostId = "fault-matrix.playwright";
export const evidenceArtifactId = "agent.fault-matrix.probe";

function entry(key, expectedStatus, behavior) {
  return Object.freeze({ key, id: `reference-agent.p3-088.${key}`, expectedStatus, ...behavior });
}
