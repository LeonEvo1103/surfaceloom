import type { TraceValue } from "@surfaceloom/core";
import type { SourceArtifact } from "../../model.js";

export const judgeEvidenceSchemaVersionV3 = "surfaceloom.judge-evidence/v1" as const;

export interface JudgeEvidenceBindingV3 {
  readonly reportRunId: string;
  readonly caseExecutionId: string;
  readonly attemptId: string;
  readonly judgeCriterionId: string;
  readonly acceptanceCriterionId: string;
}

export interface JudgeEvidenceInputV3 {
  readonly artifactId: string;
  readonly capturedAt: string;
  readonly sourcePath: string;
  readonly binding: JudgeEvidenceBindingV3;
  readonly correlationId: string;
  readonly evidence: readonly {
    readonly evidenceId: string;
    readonly artifactId: string;
  }[];
  readonly outcome: TraceValue;
  readonly decision: {
    readonly status: "passed" | "failed";
    readonly reason: string;
  };
}

export interface JudgeEvidenceRecordV3 {
  readonly schemaVersion: typeof judgeEvidenceSchemaVersionV3;
  readonly binding: JudgeEvidenceBindingV3;
  readonly correlationId: string;
  readonly evidence: JudgeEvidenceInputV3["evidence"];
  readonly outcome: TraceValue;
  readonly decision: JudgeEvidenceInputV3["decision"];
}

export interface JudgeEvidenceOutputV3 {
  readonly record: JudgeEvidenceRecordV3;
  readonly artifact: SourceArtifact;
}
