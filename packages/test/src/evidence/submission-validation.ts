import {
  defineEvidenceSource,
  type EvidenceRef,
  type EvidenceSource,
} from "@surfaceloom/core";

import type { EvidenceSubmission } from "./collector.js";
import { identifier, type ExecutionScope } from "./execution-scope.js";
import { jsonSnapshot } from "./json-data.js";

export function assertRefScope(ref: EvidenceRef, scope: ExecutionScope): void {
  if (ref.caseExecutionId !== scope.caseExecutionId
      || (ref.kind !== "caseExecution" && ref.attemptId !== scope.attemptId)) {
    throw new Error("Evidence reference crosses case or attempt scope.");
  }
}

export function assertSource(actual: EvidenceSource, expected: EvidenceSource): void {
  const normalized = defineEvidenceSource(actual);
  secureSource(normalized);
  if (normalized.kind !== expected.kind || normalized.producerId !== expected.producerId
      || normalized.sourceRecordId !== expected.sourceRecordId) {
    throw new Error("Evidence declaration source differs from its submission producer.");
  }
}

export function secureSource(source: EvidenceSource): void {
  identifier("source producerId", source.producerId);
  identifier("source sourceRecordId", source.sourceRecordId);
}

export function secureRef(ref: EvidenceRef): void {
  identifier("reference caseExecutionId", ref.caseExecutionId);
  if (ref.kind === "caseExecution") return;
  identifier("reference attemptId", ref.attemptId);
  if (ref.kind === "attempt") return;
  if (ref.kind === "step") identifier("reference stepId", ref.stepId);
  else if (ref.kind === "agentRun") identifier("reference runId", ref.runId);
  else if (ref.kind === "toolCall") {
    identifier("reference runId", ref.runId);
    identifier("reference callId", ref.callId);
  } else identifier("reference artifactId", ref.artifactId);
}

export function exactSubmission(input: EvidenceSubmission): EvidenceSubmission {
  const snapshot = jsonSnapshot(input, "evidence submission") as unknown as EvidenceSubmission;
  const allowed = ["id", "scope", "source", "artifact", "nodes", "relations", "content",
    "completeness", "capturedAt", "correlationId"];
  if (Object.keys(snapshot).some((key) => !allowed.includes(key))) {
    throw new Error("Evidence submission contains unknown metadata.");
  }
  if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.relations)) {
    throw new Error("Evidence nodes and relations must be arrays.");
  }
  // Validation above proved every reachable field is a getter-free, non-Proxy data field.
  // Preserve opaque runner-issued identities from the original graph.
  return input;
}

export function evidenceTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 80
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
      || !Number.isFinite(Date.parse(value))) throw new Error("Evidence timestamp is invalid.");
  return value;
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be positive.`);
  return value;
}
