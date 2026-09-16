import type {
  ArtifactKind,
  EvidencePolicy,
  SourceArtifact,
  TestStatus,
} from "./model.js";

export const defaultEvidencePolicy: EvidencePolicy = Object.freeze({
  screenshots: "on-failure",
  video: "on-failure",
  trace: "always",
  accessibilityTree: "on-failure",
  logs: "always",
});

export function retainEvidence(
  artifact: SourceArtifact,
  status: TestStatus,
  policy: EvidencePolicy,
): boolean {
  if (artifact.captureStatus !== "captured") return true;
  const failed = status === "failed" || status === "timedOut";
  const mode = retentionFor(artifact.kind, policy);
  if (mode === "off") return false;
  if (mode === "always") return true;
  return failed;
}

function retentionFor(
  kind: ArtifactKind,
  policy: EvidencePolicy,
): "off" | "on-failure" | "always" {
  switch (kind) {
    case "screenshot":
    case "videoFrame":
      return policy.screenshots;
    case "video":
      return policy.video;
    case "trace":
    case "agentLoop":
      return policy.trace;
    case "accessibilityTree":
      return policy.accessibilityTree;
    case "log":
    case "diagnostics":
      return policy.logs;
  }
}
