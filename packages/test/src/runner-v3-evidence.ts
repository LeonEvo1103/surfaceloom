import { types } from "node:util";

import type { EvidenceCompleteness } from "./evidence/content.js";
import { jsonSnapshot } from "./evidence/json-data.js";
import type { CaseEvidenceSubmissionV3 } from "./runner-v3-contracts.js";

const fields = ["id", "artifactId", "content", "completeness", "correlationId"] as const;

/** Snapshots the complete author envelope before reading any caller-controlled field. */
export function snapshotCaseEvidenceSubmissionV3(input: unknown): CaseEvidenceSubmissionV3 {
  if (typeof input !== "object" || input === null || types.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new Error("Case evidence submission must be a plain data object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > fields.length || keys.some((key) => typeof key !== "string"
      || !fields.includes(key as typeof fields[number]))) {
    throw new Error("Case evidence submission contains unknown authority metadata.");
  }
  const required = (name: "id" | "artifactId" | "content"): unknown =>
    data(descriptors[name], `Case evidence ${name}`, false);
  const optional = (name: "completeness" | "correlationId"): unknown =>
    data(descriptors[name], `Case evidence ${name}`, true);
  const id = required("id");
  const artifactId = required("artifactId");
  const content = jsonSnapshot(required("content"), "Case evidence content");
  const completenessInput = optional("completeness");
  const correlationId = optional("correlationId");
  if (typeof id !== "string" || typeof artifactId !== "string") {
    throw new Error("Case evidence ids must be strings.");
  }
  if (correlationId !== undefined && typeof correlationId !== "string") {
    throw new Error("Case evidence correlationId must be a string.");
  }
  const completeness = completenessInput === undefined ? undefined
    : jsonSnapshot(completenessInput, "Case evidence completeness") as EvidenceCompleteness;
  return Object.freeze({ id, artifactId, content,
    ...(completeness === undefined ? {} : { completeness }),
    ...(correlationId === undefined ? {} : { correlationId }) });
}

function data(descriptor: PropertyDescriptor | undefined, label: string,
  optional: boolean): unknown {
  if (descriptor === undefined) {
    if (optional) return undefined;
    throw new Error(`${label} is required.`);
  }
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new Error(`${label} must be an enumerable data field.`);
  }
  return descriptor.value;
}
