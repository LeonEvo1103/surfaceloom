import type {
  CaseReportV3Input,
  ContextValue,
  ReportSurfaceV3,
} from "@surfaceloom/reporter";

import {
  assertEvidenceCollectionSnapshot,
  assertSameExecutionAuthority,
  assertSealedSurfaceAcquisitions,
  finalAttemptScope,
  requireValidEvidence,
  sameExecutionScope,
  validateRequiredEvidence,
  type SealedSurfaceAcquisitions,
} from "../../evidence/index.js";
import type {
  AttemptAdapterInput,
  CaseAdapterInput,
  ReportAttemptV3Adapter,
} from "./contracts.js";
import { assertMaterializedEvidenceV3 } from "./materialize.js";

const issuedAttemptAdapters = new WeakSet<object>();

/** Converts only recorded facts; it has no unknown-to-known fallback and never derives verdicts. */
export function createReportV3Attempt(input: AttemptAdapterInput): ReportAttemptV3Adapter {
  assertEvidenceCollectionSnapshot(input.evidence);
  assertMaterializedEvidenceV3(input.materializedEvidence, input.evidence);
  assertSealedSurfaceAcquisitions(input.surfaces);
  if (!sameExecutionScope(input.scope, input.surfaces.scope)
      || !sameExecutionScope(input.scope, input.evidence.scope)
      || !sameExecutionScope(input.scope, input.materializedEvidence.scope)) {
    throw new Error("Report/v3 attempt inputs cross execution scopes.");
  }
  const surfaces = input.surfaces.acquisitions;
  if (input.surfaces.sealed !== true || surfaces.length === 0) {
    throw new Error("Report/v3 attempt requires sealed, actually acquired surfaces.");
  }
  requireValidEvidence(validateRequiredEvidence(input.requiredEvidencePolicy, input.evidence,
    input.materializedEvidence, input.evidencePolicy, input.result.status));
  const artifactIds = [...(input.result.artifacts ?? []), ...input.materializedEvidence.artifacts]
    .map((artifact) => artifact.id);
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new Error("Report/v3 attempt contains duplicate artifact ids.");
  }
  const attempt = Object.freeze({
    id: input.scope.attemptId,
    ordinal: input.scope.ordinal,
    executionPlatforms: Object.freeze([...new Set(surfaces.map((surface) =>
      surface.executionPlatform))].sort(platformOrder)),
    runnerHostId: Object.freeze({ state: "known" as const, value: input.scope.runnerHostId }),
    surfaceIds: Object.freeze({ state: "known" as const,
      value: Object.freeze(surfaces.map((surface) => surface.surfaceId).sort()) }),
    result: Object.freeze({
      ...input.result,
      artifacts: Object.freeze([...(input.result.artifacts ?? []),
        ...input.materializedEvidence.artifacts]),
    }),
  });
  const adapted = Object.freeze({ scope: input.scope, attempt });
  issuedAttemptAdapters.add(adapted);
  return adapted;
}

export function createCaseReportV3(input: CaseAdapterInput): CaseReportV3Input {
  if (input.attempts.length === 0) throw new Error("Report/v3 Case requires an attempt.");
  const ordered = [...input.attempts].sort((left, right) =>
    left.scope.ordinal - right.scope.ordinal);
  const finalScope = finalAttemptScope(input.finalAttempt);
  for (const [index, item] of ordered.entries()) {
    if (!issuedAttemptAdapters.has(item)) throw new Error("Report/v3 attempt was not runner-adapted.");
    assertSameExecutionAuthority(finalScope, item.scope);
    if (item.scope.caseExecutionId !== input.finalAttempt.caseExecutionId
        || item.scope.ordinal !== index + 1
        || item.scope.attemptId !== item.attempt.id) {
      throw new Error("Report/v3 Case attempts do not match runner-issued scopes.");
    }
  }
  const final = ordered.at(-1)!;
  if (final.scope.attemptId !== input.finalAttempt.finalAttemptId
      || final.scope.ordinal !== input.finalAttempt.ordinal || final.scope !== finalScope) {
    throw new Error("Report/v3 final attempt is not the runner-selected highest ordinal.");
  }
  return Object.freeze({
    spec: input.spec,
    attempts: Object.freeze({
      state: "known",
      finalAttemptId: final.scope.attemptId,
      items: Object.freeze(ordered.map((item) => item.attempt)),
    }),
  });
}

export function createSurfaceCatalogV3(
  snapshots: readonly SealedSurfaceAcquisitions[],
): ContextValue<readonly ReportSurfaceV3[]> {
  const byId = new Map<string, ReportSurfaceV3>();
  for (const snapshot of snapshots) {
    assertSealedSurfaceAcquisitions(snapshot);
    for (const surface of snapshot.acquisitions) {
      const reportSurface = Object.freeze({
        id: surface.surfaceId,
        kind: surface.kind,
        hostId: Object.freeze({ state: "known" as const, value: surface.hostId }),
        capabilities: surface.effectiveCapabilities,
      });
      const prior = byId.get(surface.surfaceId);
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(reportSurface)) {
        throw new Error(`Surface ${surface.surfaceId} has conflicting recorded facts.`);
      }
      byId.set(surface.surfaceId, reportSurface);
    }
  }
  if (byId.size === 0) throw new Error("Known surface catalog must not be empty.");
  return Object.freeze({ state: "known", value: Object.freeze([...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id))) });
}

function platformOrder(left: string, right: string): number {
  const values = ["macos", "windows", "web"];
  return values.indexOf(left) - values.indexOf(right);
}
