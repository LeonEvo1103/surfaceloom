import type { EvidenceCollectionSnapshot, RequiredEvidencePolicy } from "../../evidence/index.js";
import { assertRequiredEvidencePolicy, identifier } from "../../evidence/index.js";
import type { MaterializedEvidenceV3 } from "./contracts.js";
import { assertMaterializedEvidenceV3, materializedEvidenceIntegrity } from "./materialize.js";

export interface RequiredReportArtifactReferenceV3 {
  readonly caseId: string;
  readonly attemptId: string;
  readonly artifactId: string;
  readonly expectedSizeBytes: number;
  readonly expectedSha256: string;
}

/** Projects Reporter refs only from a genuine receipt and runner-issued policy. */
export function requiredReportArtifactsV3(caseIdInput: string, policy: RequiredEvidencePolicy,
  receipt: MaterializedEvidenceV3, snapshot: EvidenceCollectionSnapshot,
): readonly RequiredReportArtifactReferenceV3[] {
  assertMaterializedEvidenceV3(receipt, snapshot);
  assertRequiredEvidencePolicy(policy, snapshot.scope);
  const caseId = identifier("report caseId", caseIdInput);
  const byId = new Map(materializedEvidenceIntegrity(receipt, snapshot)
    .map((item) => [item.artifactId, item]));
  return Object.freeze(policy.requirements.map((requirement) => {
    const item = byId.get(requirement.artifactId);
    if (item === undefined) throw new Error("Required evidence has no materialized integrity record.");
    return Object.freeze({ caseId, attemptId: snapshot.scope.attemptId,
      artifactId: requirement.artifactId, expectedSizeBytes: item.sizeBytes,
      expectedSha256: item.sha256 });
  }));
}
