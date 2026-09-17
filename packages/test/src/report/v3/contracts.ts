import type { CaseSpec } from "@surfaceloom/core";
import type {
  CaseAttemptV3Input,
  CaseReportV3Input,
  EvidencePolicy,
  SourceArtifact,
} from "@surfaceloom/reporter";

import type {
  EvidenceCollectionSnapshot,
  ExecutionScope,
  FinalAttemptSelection,
  RequiredEvidencePolicy,
  SealedSurfaceAcquisitions,
} from "../../evidence/index.js";
export interface MaterializedEvidenceV3 {
  readonly scope: ExecutionScope;
  readonly artifacts: readonly SourceArtifact[];
}

export interface ReportAttemptV3Adapter {
  readonly scope: ExecutionScope;
  readonly attempt: CaseAttemptV3Input;
}

export interface AttemptAdapterInput {
  readonly scope: ExecutionScope;
  readonly surfaces: SealedSurfaceAcquisitions;
  readonly evidence: EvidenceCollectionSnapshot;
  readonly materializedEvidence: MaterializedEvidenceV3;
  readonly requiredEvidencePolicy: RequiredEvidencePolicy;
  readonly evidencePolicy: EvidencePolicy;
  readonly result: CaseAttemptV3Input["result"];
}

export interface CaseAdapterInput {
  readonly spec: CaseSpec;
  readonly attempts: readonly ReportAttemptV3Adapter[];
  readonly finalAttempt: FinalAttemptSelection;
}

export type AdaptedCaseReportV3 = CaseReportV3Input;
