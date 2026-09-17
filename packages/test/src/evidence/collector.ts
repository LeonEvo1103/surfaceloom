import {
  defineEvidenceContext,
  defineEvidenceRef,
  defineEvidenceSource,
  evidenceContextSchemaVersion,
  evidenceRefKey,
  type EvidenceContext,
  type EvidenceNode,
  type EvidenceRef,
  type EvidenceRelation,
  type EvidenceSource,
} from "@surfaceloom/core";

import {
  normalizeCompleteness,
  normalizeEvidenceContent,
  type EvidenceCompleteness,
  type NormalizedEvidenceContent,
} from "./content.js";
import {
  assertIssuedExecutionScope,
  identifier,
  sameExecutionScope,
  type ExecutionScope,
} from "./execution-scope.js";
import { jsonSnapshot } from "./json-data.js";
import {
  assertRefScope,
  assertSource,
  evidenceTimestamp,
  exactSubmission,
  positiveInteger,
  secureRef,
  secureSource,
} from "./submission-validation.js";

const GRAPH_ARTIFACT_ID = "evidence.graph";
const RESERVED_RELATION_PREFIX = "runner.evidence.";
const sealedEvidenceSnapshots = new WeakSet<object>();

export function assertEvidenceCollectionSnapshot(value: EvidenceCollectionSnapshot): void {
  if (!sealedEvidenceSnapshots.has(value)) {
    throw new Error("Evidence snapshot was not sealed by its collector.");
  }
}

export interface EvidenceSubmission {
  readonly id: string;
  readonly scope: ExecutionScope;
  readonly source: EvidenceSource;
  readonly artifact: EvidenceRef;
  readonly nodes: readonly EvidenceNode[];
  readonly relations: readonly EvidenceRelation[];
  readonly content: unknown;
  readonly completeness: EvidenceCompleteness;
  readonly capturedAt: string;
  /** Diagnostic grouping only. It never creates an evidence edge. */
  readonly correlationId?: string;
}

export interface CollectedEvidenceArtifact {
  readonly submissionId: string;
  readonly artifact: EvidenceRef & { readonly kind: "artifact" };
  readonly source: EvidenceSource;
  readonly content: NormalizedEvidenceContent;
  readonly completeness: EvidenceCompleteness;
  readonly capturedAt: string;
  readonly correlationId?: string;
  /** Raw producer JSON bytes and normalized/redacted JSON bytes are enforced independently. */
  readonly rawSizeBytes: number;
  readonly normalizedSizeBytes: number;
  readonly sizeBytes: number;
}

export interface EvidenceCollectionSnapshot {
  readonly scope: ExecutionScope;
  readonly context: EvidenceContext;
  readonly artifacts: readonly CollectedEvidenceArtifact[];
  readonly graphArtifactId: typeof GRAPH_ARTIFACT_ID;
  readonly graphCapturedAt: string;
  readonly completeness: EvidenceCompleteness;
}

export interface EvidenceCollectorOptions {
  readonly maxArtifactBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxSubmissions?: number;
}

/** Validates each atomic submission before committing it; no forward/dangling refs are allowed. */
export class EvidenceSubmissionCollector {
  readonly #scope: ExecutionScope;
  readonly #source: EvidenceSource;
  readonly #maxArtifactBytes: number;
  readonly #maxTotalBytes: number;
  readonly #maxSubmissions: number;
  #context: EvidenceContext;
  #artifacts: CollectedEvidenceArtifact[] = [];
  #ids = new Set<string>();
  #totalRawBytes = 0;
  #totalNormalizedBytes = 0;
  #sealed = false;

  constructor(scope: ExecutionScope, options: EvidenceCollectorOptions = {}) {
    assertIssuedExecutionScope(scope);
    jsonSnapshot(options, "evidence collector options");
    if (Object.keys(options).some((key) => ![
      "maxArtifactBytes", "maxTotalBytes", "maxSubmissions",
    ].includes(key))) throw new Error("Evidence collector options contain unknown metadata.");
    this.#scope = scope;
    this.#maxArtifactBytes = positiveInteger(options.maxArtifactBytes ?? 256 * 1024, "artifact byte budget");
    this.#maxTotalBytes = positiveInteger(options.maxTotalBytes ?? 2 * 1024 * 1024, "total byte budget");
    this.#maxSubmissions = positiveInteger(options.maxSubmissions ?? 1_000, "submission limit");
    this.#source = defineEvidenceSource({
      kind: "runner",
      producerId: scope.runnerHostId,
      sourceRecordId: `scope.${scope.caseExecutionId}.${scope.attemptId}`,
    });
    const caseNode = Object.freeze({
      kind: "caseExecution" as const,
      caseExecutionId: scope.caseExecutionId,
      source: this.#source,
    });
    const attemptNode = Object.freeze({
      kind: "attempt" as const,
      caseExecutionId: scope.caseExecutionId,
      attemptId: scope.attemptId,
      source: this.#source,
    });
    this.#context = defineEvidenceContext({
      schemaVersion: evidenceContextSchemaVersion,
      caseExecutionId: scope.caseExecutionId,
      nodes: [caseNode, attemptNode],
      relations: [{
        id: `${RESERVED_RELATION_PREFIX}scope`,
        relation: "contains",
        from: { kind: "caseExecution", caseExecutionId: scope.caseExecutionId },
        to: { kind: "attempt", caseExecutionId: scope.caseExecutionId,
          attemptId: scope.attemptId },
        source: this.#source,
      }],
    });
  }

  submit(input: EvidenceSubmission): CollectedEvidenceArtifact {
    if (this.#sealed) throw new Error("Late evidence submission after seal.");
    input = exactSubmission(input);
    if (!sameExecutionScope(this.#scope, input.scope)) {
      throw new Error("Evidence submission crosses execution scopes.");
    }
    const id = identifier("submission id", input.id);
    if (this.#ids.has(id)) throw new Error("Duplicate evidence submission id.");
    if (this.#artifacts.length >= this.#maxSubmissions) {
      throw new Error("Evidence submission limit exceeded.");
    }
    const source = defineEvidenceSource(input.source);
    const artifact = defineEvidenceRef(input.artifact);
    secureSource(source);
    if (artifact.kind !== "artifact") throw new Error("Evidence content requires an artifact ref.");
    if (artifact.artifactId === GRAPH_ARTIFACT_ID) throw new Error("Reserved graph artifact id.");
    assertRefScope(artifact, this.#scope);
    const normalized = normalizeEvidenceContent(input.content, this.#maxArtifactBytes);
    if (this.#totalRawBytes + normalized.rawSizeBytes > this.#maxTotalBytes
        || this.#totalNormalizedBytes + normalized.normalizedSizeBytes > this.#maxTotalBytes) {
      throw new Error("Evidence collection exceeds its total byte budget.");
    }
    const completeness = normalizeCompleteness(input.completeness,
      normalized.forcedIncompleteReasons);
    const capturedAt = evidenceTimestamp(input.capturedAt);
    const nodes = [...input.nodes];
    const relations = [...input.relations];
    secureRef(artifact);
    if (!nodes.some((node) => evidenceRefKey(node) === evidenceRefKey(artifact))) {
      throw new Error("Evidence submission is missing its artifact node.");
    }
    if (!relations.some((relation) => evidenceRefKey(relation.from) === evidenceRefKey(artifact)
        || evidenceRefKey(relation.to) === evidenceRefKey(artifact))) {
      throw new Error("Evidence content is not linked through its artifact ref.");
    }
    for (const node of nodes) {
      secureRef(node);
      assertSource(node.source, source);
    }
    for (const relation of relations) {
      if (relation.id.startsWith(RESERVED_RELATION_PREFIX)) {
        throw new Error("Evidence relation uses a runner-reserved id.");
      }
      identifier("relation id", relation.id);
      secureRef(relation.from);
      secureRef(relation.to);
      assertSource(relation.source, source);
    }
    const context = defineEvidenceContext({
      schemaVersion: evidenceContextSchemaVersion,
      caseExecutionId: this.#scope.caseExecutionId,
      nodes: [...this.#context.nodes, ...nodes],
      relations: [...this.#context.relations, ...relations],
    });
    const correlationId = input.correlationId === undefined
      ? undefined : identifier("correlationId", input.correlationId);
    const collected = Object.freeze({
      submissionId: id,
      artifact: artifact as EvidenceRef & { readonly kind: "artifact" },
      source,
      content: normalized.content,
      completeness,
      capturedAt,
      ...(correlationId === undefined ? {} : { correlationId }),
      rawSizeBytes: normalized.rawSizeBytes,
      normalizedSizeBytes: normalized.normalizedSizeBytes,
      sizeBytes: normalized.normalizedSizeBytes,
    });
    this.#context = context;
    this.#ids.add(id);
    this.#artifacts.push(collected);
    this.#totalRawBytes += normalized.rawSizeBytes;
    this.#totalNormalizedBytes += normalized.normalizedSizeBytes;
    return collected;
  }

  seal(input: { readonly capturedAt: string }): EvidenceCollectionSnapshot {
    if (this.#sealed) throw new Error("Evidence collector is already sealed.");
    jsonSnapshot(input, "evidence seal");
    if (Object.keys(input).some((key) => key !== "capturedAt")) {
      throw new Error("Evidence seal contains unknown metadata.");
    }
    const graphCapturedAt = evidenceTimestamp(input.capturedAt);
    const graphNode = Object.freeze({
      kind: "artifact" as const,
      caseExecutionId: this.#scope.caseExecutionId,
      attemptId: this.#scope.attemptId,
      artifactId: GRAPH_ARTIFACT_ID,
      source: this.#source,
    });
    this.#context = defineEvidenceContext({
      schemaVersion: evidenceContextSchemaVersion,
      caseExecutionId: this.#scope.caseExecutionId,
      nodes: [...this.#context.nodes, graphNode],
      relations: [...this.#context.relations, {
        id: `${RESERVED_RELATION_PREFIX}graph`,
        relation: "contains",
        from: { kind: "attempt", caseExecutionId: this.#scope.caseExecutionId,
          attemptId: this.#scope.attemptId },
        to: { kind: "artifact", caseExecutionId: this.#scope.caseExecutionId,
          attemptId: this.#scope.attemptId, artifactId: GRAPH_ARTIFACT_ID },
        source: this.#source,
      }],
    });
    this.#sealed = true;
    const incomplete = this.#artifacts.flatMap((item) =>
      item.completeness.state === "incomplete" ? item.completeness.reasons : []);
    const completeness: EvidenceCompleteness = incomplete.length === 0
      ? Object.freeze({ state: "complete" })
      : Object.freeze({ state: "incomplete", reasons: Object.freeze([...new Set(incomplete)].sort()) });
    const snapshot = Object.freeze({
      scope: this.#scope,
      context: this.#context,
      artifacts: Object.freeze([...this.#artifacts]),
      graphArtifactId: GRAPH_ARTIFACT_ID,
      graphCapturedAt,
      completeness,
    });
    sealedEvidenceSnapshots.add(snapshot);
    return snapshot;
  }
}
