import type { JudgeRequest } from "../src/index.js";

export function request(overrides: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    serviceRunId: "run-1",
    rubricVersion: "routing-v1",
    question: "Which route is visible?",
    allowedLabels: ["sign-in", "sign-up"],
    evidence: [
      {
        kind: "text",
        evidenceId: "ev-1",
        serviceRunId: "run-1",
        origin: { kind: "serviceArtifact", artifactId: "artifact-1" },
        contentType: "text/plain",
        text: "Heading: Create account",
      },
    ],
    ...overrides,
  };
}

export function classified(label = "sign-up") {
  return {
    status: "classified",
    label,
    confidence: 0.9,
    reasons: ["The visible heading identifies the registration route."],
    evidenceRefs: ["ev-1"],
    observedFacts: [{
      kind: "observed",
      scope: "ui",
      statement: "The heading says Create account.",
      evidenceRefs: ["ev-1"],
    }],
    hypotheses: [{
      kind: "hypothesis",
      scope: "backend",
      statement: "The routing rule may have selected the new-account flow.",
      evidenceRefs: ["ev-1"],
      verificationNeeded: "Inspect routing inputs and server-side route selection.",
    }],
    providerMetadata: {
      provider: "fake",
      model: "script-value-is-overridden",
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    },
  };
}
