import {
  retainEvidence,
  type EvidencePolicy,
  type SourceArtifact,
  type TestStatus,
} from "@surfaceloom/reporter";

import { assertEvidenceCollectionSnapshot, type EvidenceCollectionSnapshot } from "./collector.js";
import {
  assertIssuedExecutionScope,
  identifier,
  sameExecutionScope,
  type ExecutionScope,
} from "./execution-scope.js";
import { jsonSnapshot } from "./json-data.js";
import { assertMaterializedEvidenceV3 } from "../report/v3/materialize.js";

const issuedPolicies = new WeakSet<object>();

export interface RequiredEvidenceRequirement {
  readonly artifactId: string;
  readonly requireComplete: boolean;
}

export interface RequiredEvidencePolicy {
  readonly scope: ExecutionScope;
  readonly requirements: readonly RequiredEvidenceRequirement[];
}

export type RequiredEvidenceFailureCode =
  | "requiredMissing"
  | "requiredIncomplete"
  | "materializedMissing"
  | "materializedUnavailable"
  | "retentionRemoved";

export interface RequiredEvidenceFailure {
  readonly phase: "collection" | "materialization" | "retention";
  readonly code: RequiredEvidenceFailureCode;
  readonly artifactId: string;
  readonly message: string;
}

export type RequiredEvidenceValidation =
  | { readonly status: "passed"; readonly failures: readonly [] }
  | { readonly status: "failed"; readonly failures: readonly RequiredEvidenceFailure[] };

export interface RequiredEvidenceMaterialization {
  readonly scope: ExecutionScope;
  readonly artifacts: readonly SourceArtifact[];
}

export class RunnerRequiredEvidenceAuthority {
  readonly #scopes = new Set<ExecutionScope>();

  issue(scope: ExecutionScope,
    requirements: readonly RequiredEvidenceRequirement[]): RequiredEvidencePolicy {
    assertIssuedExecutionScope(scope);
    jsonSnapshot(requirements, "required evidence requirements");
    if (this.#scopes.has(scope)) throw new Error("Required evidence policy is already issued for this scope.");
    if (!Array.isArray(requirements) || requirements.length > 1_000) {
      throw new Error("Required evidence requirements must be a bounded array.");
    }
    const ids = new Set<string>();
    const normalized = requirements.map((requirement) => {
      if (typeof requirement !== "object" || requirement === null
          || Object.keys(requirement).some((key) => !["artifactId", "requireComplete"].includes(key))
          || typeof requirement.requireComplete !== "boolean") {
        throw new Error("Required evidence requirement is invalid.");
      }
      const artifactId = identifier("required artifactId", requirement.artifactId);
      if (ids.has(artifactId)) throw new Error("Duplicate required evidence artifact id.");
      ids.add(artifactId);
      return Object.freeze({ artifactId, requireComplete: requirement.requireComplete });
    });
    const policy = Object.freeze({ scope, requirements: Object.freeze(normalized) });
    this.#scopes.add(scope);
    issuedPolicies.add(policy);
    return policy;
  }
}

export function validateRequiredEvidence(
  policy: RequiredEvidencePolicy,
  snapshot: EvidenceCollectionSnapshot,
  materialized: RequiredEvidenceMaterialization,
  evidencePolicy: EvidencePolicy,
  status: TestStatus,
): RequiredEvidenceValidation {
  assertEvidenceCollectionSnapshot(snapshot);
  assertMaterializedEvidenceV3(materialized, snapshot);
  assertPolicy(policy, snapshot.scope, materialized.scope);
  const collected = new Map(snapshot.artifacts.map((item) => [
    item.artifact.artifactId, item.completeness,
  ]));
  collected.set(snapshot.graphArtifactId, snapshot.completeness);
  const staged = new Map(materialized.artifacts.map((artifact) => [artifact.id, artifact]));
  const failures: RequiredEvidenceFailure[] = [];
  for (const requirement of policy.requirements) {
    const completeness = collected.get(requirement.artifactId);
    if (completeness === undefined) {
      failures.push(failure("collection", "requiredMissing", requirement.artifactId,
        "Required evidence was not submitted."));
      continue;
    }
    if (requirement.requireComplete && completeness.state !== "complete") {
      failures.push(failure("collection", "requiredIncomplete", requirement.artifactId,
        "Required evidence is incomplete."));
    }
    const artifact = staged.get(requirement.artifactId);
    if (artifact === undefined) {
      failures.push(failure("materialization", "materializedMissing", requirement.artifactId,
        "Required evidence is missing from materialized artifacts."));
      continue;
    }
    if (artifact.captureStatus !== "captured" || artifact.sourcePath === undefined) {
      failures.push(failure("materialization", "materializedUnavailable", requirement.artifactId,
        "Required evidence did not materialize as a captured artifact."));
      continue;
    }
    if (!retainEvidence(artifact, status, evidencePolicy)) {
      failures.push(failure("retention", "retentionRemoved", requirement.artifactId,
        "Reporter retention policy would remove required evidence."));
    }
  }
  return failures.length === 0
    ? Object.freeze({ status: "passed", failures: Object.freeze([]) as readonly [] })
    : Object.freeze({ status: "failed", failures: Object.freeze(failures) });
}

export function assertRequiredEvidencePolicy(policy: RequiredEvidencePolicy,
  scope: ExecutionScope): void {
  if (!issuedPolicies.has(policy) || !sameExecutionScope(policy.scope, scope)) {
    throw new Error("Required evidence policy was not runner-issued for this execution scope.");
  }
}

export class RequiredEvidenceValidationError extends Error {
  constructor(readonly validation: RequiredEvidenceValidation & { readonly status: "failed" }) {
    super("Required evidence validation failed.");
    this.name = "RequiredEvidenceValidationError";
  }
}

export function requireValidEvidence(validation: RequiredEvidenceValidation): void {
  if (validation.status === "failed") throw new RequiredEvidenceValidationError(validation);
}

export interface RequiredEvidenceFailureMerge<T> {
  readonly primaryFailure: T | RequiredEvidenceFailure | undefined;
  readonly failures: readonly (T | RequiredEvidenceFailure)[];
  readonly evidenceFailures: readonly RequiredEvidenceFailure[];
}

/** Additive failure merge: an existing body/setup/cleanup failure always stays primary. */
export function mergeRequiredEvidenceFailures<T>(
  primary: T | undefined,
  validation: RequiredEvidenceValidation,
): RequiredEvidenceFailureMerge<T> {
  const evidenceFailures = validation.failures;
  const failures = Object.freeze([
    ...(primary === undefined ? [] : [primary]),
    ...evidenceFailures,
  ] as (T | RequiredEvidenceFailure)[]);
  return Object.freeze({
    primaryFailure: primary ?? evidenceFailures[0],
    failures,
    evidenceFailures,
  });
}

function assertPolicy(
  policy: RequiredEvidencePolicy,
  snapshotScope: ExecutionScope,
  materializedScope: ExecutionScope,
): void {
  if (!issuedPolicies.has(policy)) throw new Error("Required evidence policy was not runner-issued.");
  if (!sameExecutionScope(policy.scope, snapshotScope)
      || !sameExecutionScope(policy.scope, materializedScope)) {
    throw new Error("Required evidence inputs cross execution scopes.");
  }
}

function failure(phase: RequiredEvidenceFailure["phase"], code: RequiredEvidenceFailureCode,
  artifactId: string, message: string): RequiredEvidenceFailure {
  return Object.freeze({ phase, code, artifactId, message });
}
