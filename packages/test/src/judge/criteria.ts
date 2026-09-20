import { types } from "node:util";

import { identifier } from "../evidence/execution-scope.js";
import { jsonSnapshot } from "../evidence/json-data.js";
import type { JudgeCriterionV3 } from "./contracts.js";

const fields = ["id", "criterionId", "rubricVersion", "question", "allowedLabels",
  "passLabels", "evidenceArtifactIds"] as const;

export function snapshotJudgeCriteriaV3(input: unknown,
  acceptanceCriterionIds: readonly string[]): readonly JudgeCriterionV3[] {
  if (input === undefined) return Object.freeze([]);
  if (typeof input !== "object" || input === null || types.isProxy(input)
      || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error("Case v3 judgeCriteria must be a plain array.");
  }
  const snapshot = jsonSnapshot(input, "Case v3 judgeCriteria") as unknown[];
  if (snapshot.length > 32) throw new Error("Case v3 judgeCriteria exceeds 32 items.");
  const accepted = new Set(acceptanceCriterionIds);
  const ids = new Set<string>();
  const criterionIds = new Set<string>();
  const normalized = snapshot.map((item, index): JudgeCriterionV3 => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`Case v3 judgeCriteria[${index}] must be an object.`);
    }
    const value = item as Record<string, unknown>;
    if (Object.keys(value).some((key) => !fields.includes(key as typeof fields[number]))) {
      throw new Error(`Case v3 judgeCriteria[${index}] contains unknown metadata.`);
    }
    const id = identifier("Judge criterion id", value.id);
    const criterionId = identifier("Judge acceptance criterion id", value.criterionId);
    if (!accepted.has(criterionId)) throw new Error(`Judge criterion ${id} references an unknown acceptance criterion.`);
    if (ids.has(id) || criterionIds.has(criterionId)) {
      throw new Error("Judge criteria contain a duplicate id or acceptance criterion binding.");
    }
    ids.add(id);
    criterionIds.add(criterionId);
    const allowedLabels = identifiers(value.allowedLabels, "allowedLabels", 32);
    const passLabels = identifiers(value.passLabels, "passLabels", 32);
    if (allowedLabels.length === 0 || passLabels.length === 0
        || passLabels.some((label) => !allowedLabels.includes(label))) {
      throw new Error(`Judge criterion ${id} has invalid pass labels.`);
    }
    const evidenceArtifactIds = identifiers(value.evidenceArtifactIds,
      "evidenceArtifactIds", 32);
    if (evidenceArtifactIds.length === 0) {
      throw new Error(`Judge criterion ${id} must bind evidence explicitly.`);
    }
    if (typeof value.question !== "string" || value.question.trim().length === 0
        || value.question.length > 4_000) throw new Error(`Judge criterion ${id} has an invalid question.`);
    return Object.freeze({ id, criterionId,
      rubricVersion: identifier("Judge rubricVersion", value.rubricVersion),
      question: value.question.trim(), allowedLabels, passLabels, evidenceArtifactIds });
  });
  return Object.freeze(normalized);
}

function identifiers(input: unknown, label: string, limit: number): readonly string[] {
  if (!Array.isArray(input) || input.length > limit) throw new Error(`Judge ${label} must be a bounded array.`);
  const result = input.map((item) => identifier(`Judge ${label}`, item));
  if (new Set(result).size !== result.length) throw new Error(`Judge ${label} contains duplicates.`);
  return Object.freeze(result);
}
