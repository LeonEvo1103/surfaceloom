import type { SourceArtifact } from "@surfaceloom/reporter";
import type { JudgeProvider } from "@surfaceloom/llm-judge";
import type { RequiredReportArtifactReferenceV3 } from "../report/v3/required-artifacts.js";
import type { RunCaseV3FailureOrigin } from "../failure-origin.js";

export interface JudgeCriterionV3 {
  readonly id: string;
  readonly criterionId: string;
  readonly rubricVersion: string;
  readonly question: string;
  readonly allowedLabels: readonly string[];
  readonly passLabels: readonly string[];
  readonly evidenceArtifactIds: readonly string[];
}

export interface JudgeRunnerBindingV3 {
  readonly provider: JudgeProvider;
  /** Optional stricter absolute deadline; the Case execution deadline always applies. */
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
}

export interface CaseImageEvidenceSubmissionV3 {
  readonly id: string;
  readonly artifactId: string;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
  readonly bytes: Uint8Array;
  readonly completeness?: import("../evidence/content.js").EvidenceCompleteness;
  readonly correlationId?: string;
}

export interface JudgeIntegrationV3Result {
  readonly steps: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: "passed" | "failed";
    readonly durationMs: number;
    readonly assertion: string;
    readonly criterionIds: readonly string[];
  }[];
  readonly artifacts: readonly SourceArtifact[];
  readonly requiredArtifacts: readonly RequiredReportArtifactReferenceV3[];
  readonly failed: boolean;
  readonly failureOrigin: RunCaseV3FailureOrigin;
  readonly failureMessage?: string;
}
