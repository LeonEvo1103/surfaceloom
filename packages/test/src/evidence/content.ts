import type { TraceValue } from "@surfaceloom/core";
import { redactReportText, redactTraceValue } from "@surfaceloom/reporter";

import { identifier } from "./execution-scope.js";
import { jsonSnapshot } from "./json-data.js";

export type EvidenceCompletenessReason =
  | "producerDeclaredIncomplete"
  | "journalUnsealed"
  | "journalSequenceIncomplete";

export type EvidenceCompleteness =
  | { readonly state: "complete" }
  | { readonly state: "incomplete"; readonly reasons: readonly EvidenceCompletenessReason[] };

export type NormalizedEvidenceContent =
  | { readonly kind: "trace"; readonly schemaVersion: string; readonly trace: TraceValue }
  | { readonly kind: "probe"; readonly probeId: string; readonly resource: string;
      readonly outcome: "observed" | "notObserved" | "unknown"; readonly value?: TraceValue }
  | NativeEvidenceContent
  | NativeJournalContent;

export interface NativeEvidenceContent {
  readonly kind: "nativeOperation" | "nativeProbe";
  readonly runId: string | null;
  readonly callId: string | null;
  readonly operationId: string | null;
  readonly hostInstanceId: string;
  readonly sessionId: string;
  readonly targetIdentity: string;
  readonly resource: string;
  readonly outcome: "succeeded" | "failed" | "unknown";
  readonly detail?: TraceValue;
}

export interface NativeJournalEntry extends Omit<NativeEvidenceContent, "kind"> {
  readonly sequence?: number;
}

export interface NativeJournalContent {
  readonly kind: "nativeJournal";
  readonly bounded: true;
  readonly entries: readonly NativeJournalEntry[];
  readonly seal?: { readonly lastSequence: number };
}

export interface NormalizedContentResult {
  readonly content: NormalizedEvidenceContent;
  readonly forcedIncompleteReasons: readonly EvidenceCompletenessReason[];
  readonly rawSizeBytes: number;
  readonly normalizedSizeBytes: number;
}

export function normalizeEvidenceContent(input: unknown, maxBytes: number): NormalizedContentResult {
  const raw = jsonSnapshot(input, "evidence content") as Record<string, unknown>;
  const rawSizeBytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  if (rawSizeBytes > maxBytes) throw new Error("Evidence content exceeds its byte budget.");
  const kind = raw.kind;
  let reasons: EvidenceCompletenessReason[] = [];
  let content: NormalizedEvidenceContent;
  if (kind === "trace") content = normalizeTrace(raw);
  else if (kind === "probe") content = normalizeProbe(raw);
  else if (kind === "nativeOperation" || kind === "nativeProbe") {
    content = normalizeNative(raw, kind);
  } else if (kind === "nativeJournal") {
    const normalized = normalizeJournal(raw);
    content = normalized.content;
    reasons = normalized.reasons;
  } else throw new Error("Unknown evidence content kind.");
  const normalizedSizeBytes = Buffer.byteLength(JSON.stringify(content), "utf8");
  if (normalizedSizeBytes > maxBytes) {
    throw new Error("Normalized evidence content exceeds its byte budget.");
  }
  return Object.freeze({ content, forcedIncompleteReasons: Object.freeze(reasons),
    rawSizeBytes, normalizedSizeBytes });
}

export function normalizeCompleteness(
  input: EvidenceCompleteness,
  forced: readonly EvidenceCompletenessReason[],
): EvidenceCompleteness {
  const reasons = new Set<EvidenceCompletenessReason>(forced);
  if (input.state === "incomplete") {
    exact(input as unknown as Record<string, unknown>, ["state", "reasons"], "completeness");
    if (!Array.isArray(input.reasons) || input.reasons.length === 0) {
      throw new Error("Incomplete evidence must include a reason.");
    }
    for (const reason of input.reasons) {
      if (reason !== "producerDeclaredIncomplete" && reason !== "journalUnsealed"
          && reason !== "journalSequenceIncomplete") {
        throw new Error("Unknown evidence completeness reason.");
      }
      reasons.add(reason);
    }
  } else {
    exact(input as unknown as Record<string, unknown>, ["state"], "completeness");
    if (input.state !== "complete") throw new Error("Unknown evidence completeness state.");
  }
  return reasons.size === 0
    ? Object.freeze({ state: "complete" })
    : Object.freeze({ state: "incomplete", reasons: Object.freeze([...reasons].sort()) });
}

function normalizeTrace(raw: Record<string, unknown>): NormalizedEvidenceContent {
  exact(raw, ["kind", "schemaVersion", "trace"], "trace evidence");
  return Object.freeze({
    kind: "trace",
    schemaVersion: safeSchemaVersion(raw.schemaVersion),
    trace: redactTraceValue(raw.trace as TraceValue),
  });
}

function normalizeProbe(raw: Record<string, unknown>): NormalizedEvidenceContent {
  exact(raw, ["kind", "probeId", "resource", "outcome", "value"], "probe evidence");
  if (raw.outcome !== "observed" && raw.outcome !== "notObserved" && raw.outcome !== "unknown") {
    throw new Error("Unknown probe outcome.");
  }
  return Object.freeze({
    kind: "probe",
    probeId: identifier("probeId", raw.probeId),
    resource: identifier("probe resource", raw.resource),
    outcome: raw.outcome,
    ...(raw.value === undefined ? {} : { value: redactTraceValue(raw.value as TraceValue) }),
  });
}

function normalizeNative(
  raw: Record<string, unknown>,
  kind: NativeEvidenceContent["kind"],
  allowSequence = false,
): NativeEvidenceContent {
  exact(raw, [...(allowSequence ? ["sequence"] : ["kind"]), "runId", "callId", "operationId",
    "hostInstanceId", "sessionId", "targetIdentity", "resource", "outcome", "detail"],
  `${kind} evidence`);
  if (!allowSequence && raw.kind !== kind) throw new Error("Native evidence kind is invalid.");
  if (raw.outcome !== "succeeded" && raw.outcome !== "failed" && raw.outcome !== "unknown") {
    throw new Error("Unknown native evidence outcome.");
  }
  return Object.freeze({
    kind,
    runId: nullableIdentifier("runId", raw.runId),
    callId: nullableIdentifier("callId", raw.callId),
    operationId: nullableIdentifier("operationId", raw.operationId),
    hostInstanceId: identifier("hostInstanceId", raw.hostInstanceId),
    sessionId: identifier("sessionId", raw.sessionId),
    targetIdentity: identifier("targetIdentity", raw.targetIdentity),
    resource: identifier("native resource", raw.resource),
    outcome: raw.outcome,
    ...(raw.detail === undefined ? {} : { detail: redactTraceValue(raw.detail as TraceValue) }),
  });
}

function normalizeJournal(raw: Record<string, unknown>): {
  readonly content: NativeJournalContent;
  readonly reasons: EvidenceCompletenessReason[];
} {
  exact(raw, ["kind", "bounded", "entries", "seal"], "native journal");
  if (raw.bounded !== true || !Array.isArray(raw.entries) || raw.entries.length > 10_000) {
    throw new Error("Native journal must be a bounded entry array.");
  }
  const reasons: EvidenceCompletenessReason[] = [];
  const entries: NativeJournalEntry[] = raw.entries.map((entry, index): NativeJournalEntry => {
    const item = entry as Record<string, unknown>;
    const normalized = normalizeNative(item, "nativeOperation", true);
    const sequence = item.sequence;
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
      reasons.push("journalSequenceIncomplete");
      return Object.freeze({ ...withoutKind(normalized) });
    }
    if (index === 0 && sequence !== 1) reasons.push("journalSequenceIncomplete");
    if (index > 0) {
      const prior = (raw.entries as Record<string, unknown>[])[index - 1]?.sequence;
      if (!Number.isSafeInteger(prior) || sequence !== (prior as number) + 1) {
        reasons.push("journalSequenceIncomplete");
      }
    }
    return Object.freeze({ sequence: sequence as number, ...withoutKind(normalized) });
  });
  let seal: NativeJournalContent["seal"];
  if (raw.seal === undefined) reasons.push("journalUnsealed");
  else {
    const value = raw.seal as Record<string, unknown>;
    exact(value, ["lastSequence"], "native journal seal");
    if (!Number.isSafeInteger(value.lastSequence) || (value.lastSequence as number) < 1) {
      throw new Error("Native journal seal has an invalid sequence.");
    }
    seal = Object.freeze({ lastSequence: value.lastSequence as number });
    const last = entries.at(-1)?.sequence;
    if (last === undefined || last !== seal.lastSequence) reasons.push("journalSequenceIncomplete");
  }
  return {
    content: Object.freeze({ kind: "nativeJournal", bounded: true,
      entries: Object.freeze(entries), ...(seal === undefined ? {} : { seal }) }),
    reasons: [...new Set(reasons)],
  };
}

function withoutKind(value: NativeEvidenceContent): Omit<NativeEvidenceContent, "kind"> {
  const { kind: _kind, ...rest } = value;
  return rest;
}

function nullableIdentifier(label: string, value: unknown): string | null {
  return value === null ? null : identifier(label, value);
}

function safeSchemaVersion(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
      || value.includes("\\") || value.startsWith("/") || value.includes("../")
      || redactReportText(value) !== value) {
    throw new Error("trace schemaVersion is invalid.");
  }
  return value;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains unknown metadata.`);
  }
}
