import { types } from "node:util";

import { redactReportText, redactTraceValue } from "../../redact.js";
import { validateIdentifier, validateTimestamp, validateUnique } from "../../validation-primitives.js";
import {
  judgeEvidenceSchemaVersionV3,
  type JudgeEvidenceInputV3,
  type JudgeEvidenceOutputV3,
} from "./model.js";

/** Builds Reporter v3 evidence identity/correlation from runner-owned fields only. */
export function createJudgeEvidenceV3(input: JudgeEvidenceInputV3): JudgeEvidenceOutputV3 {
  const fixed = snapshot(input) as unknown as JudgeEvidenceInputV3;
  exact(fixed as unknown as Record<string, unknown>, ["artifactId", "capturedAt", "sourcePath",
    "binding", "correlationId", "evidence", "outcome", "decision"], "Judge evidence");
  exact(fixed.binding as unknown as Record<string, unknown>, ["reportRunId", "caseExecutionId",
    "attemptId", "judgeCriterionId", "acceptanceCriterionId"], "Judge binding");
  exact(fixed.decision as unknown as Record<string, unknown>, ["status", "reason"], "Judge decision");
  validateIdentifier("Judge artifact id", fixed.artifactId);
  validateTimestamp("Judge capturedAt", fixed.capturedAt);
  for (const [label, id] of Object.entries(fixed.binding)) validateIdentifier(label, id);
  validateIdentifier("Judge correlation id", fixed.correlationId);
  if (fixed.evidence.length === 0 || fixed.evidence.length > 32) {
    throw new Error("Judge evidence correlation must contain 1 through 32 items.");
  }
  validateUnique("Judge evidence id", fixed.evidence.map((item) => item.evidenceId));
  validateUnique("Judge evidence artifact id", fixed.evidence.map((item) => item.artifactId));
  for (const item of fixed.evidence) {
    exact(item as unknown as Record<string, unknown>, ["evidenceId", "artifactId"],
      "Judge evidence correlation");
    validateIdentifier("Judge evidence id", item.evidenceId);
    validateIdentifier("Judge evidence artifact id", item.artifactId);
  }
  if (fixed.decision.status !== "passed" && fixed.decision.status !== "failed") {
    throw new Error("Judge decision status is invalid.");
  }
  if (typeof fixed.decision.reason !== "string" || fixed.decision.reason.trim().length === 0) {
    throw new Error("Judge decision reason is required.");
  }
  const record = Object.freeze({
    schemaVersion: judgeEvidenceSchemaVersionV3,
    binding: Object.freeze({ ...fixed.binding }),
    correlationId: fixed.correlationId,
    evidence: Object.freeze(fixed.evidence.map((item) => Object.freeze({ ...item }))),
    outcome: redactTraceValue(fixed.outcome),
    decision: Object.freeze({ status: fixed.decision.status,
      reason: redactReportText(fixed.decision.reason) }),
  });
  const artifact = Object.freeze({ id: fixed.artifactId, kind: "diagnostics" as const,
    phase: "after" as const, title: `Judge：${fixed.binding.acceptanceCriterionId}`,
    captureStatus: "captured" as const, sourcePath: fixed.sourcePath,
    contentType: "application/json", capturedAt: fixed.capturedAt,
    reviewPriority: "primary" as const,
    relatedArtifactIds: Object.freeze(fixed.evidence.map((item) => item.artifactId)),
    description: `Judge ${fixed.decision.status}; correlation ${fixed.correlationId}.` });
  return Object.freeze({ record, artifact });
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains unknown metadata.`);
  }
}

function snapshot(input: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 32) throw new Error("Judge evidence input exceeds its nesting limit.");
  if (input === null || typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input !== "object" || types.isProxy(input) || seen.has(input)) {
    throw new Error("Judge evidence input must be getter-free JSON data.");
  }
  seen.add(input);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
      throw new Error("Judge evidence input contains symbol metadata.");
    }
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype) throw new Error("Judge evidence array is invalid.");
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length > 10_000) throw new Error("Judge evidence array is unbounded.");
      return Object.freeze(Array.from({ length }, (_unused, index) => {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("Judge evidence array contains a hole or accessor.");
        }
        return snapshot(descriptor.value, seen, depth + 1);
      }));
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Judge evidence object is invalid.");
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) throw new Error("Judge evidence contains an accessor.");
      result[key] = snapshot(descriptor.value, seen, depth + 1);
    }
    return Object.freeze(result);
  } finally { seen.delete(input); }
}
