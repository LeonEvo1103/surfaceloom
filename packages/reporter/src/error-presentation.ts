import type { CaseClause, TraceValue } from "@surfaceloom/core";

import type { TestErrorSummary, TestStepResult } from "./model.js";

/** Renderer-side cap; report.json keeps the full (already redacted, producer-bounded) value. */
export const errorValueDisplayLimit = 480;

export interface ErrorValueLine {
  readonly label: "期望" | "实际";
  readonly text: string;
}

export interface FailedCriterion {
  readonly id: string;
  readonly text: string;
}

/** Deterministic expected/actual lines; absent sides are omitted, never inferred. */
export function errorValueLines(error: TestErrorSummary): readonly ErrorValueLine[] {
  const lines: ErrorValueLine[] = [];
  if (error.expected !== undefined) lines.push({ label: "期望", text: displayValue(error.expected) });
  if (error.actual !== undefined) lines.push({ label: "实际", text: displayValue(error.actual) });
  return lines;
}

/** Acceptance criteria linked to failed steps, in step order and without duplicates. */
export function failedCriteria(criteria: readonly CaseClause[],
  steps: readonly TestStepResult[]): readonly FailedCriterion[] {
  const texts = new Map(criteria.map((criterion) => [criterion.id, criterion.text]));
  const seen = new Set<string>();
  const failed: FailedCriterion[] = [];
  for (const step of steps) {
    if (step.status !== "failed" && step.status !== "timedOut") continue;
    for (const id of step.criterionIds ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      failed.push({ id, text: texts.get(id) ?? step.title });
    }
  }
  return failed;
}

function displayValue(value: TraceValue): string {
  const text = JSON.stringify(value) ?? "null";
  if (text.length <= errorValueDisplayLimit) return text;
  // Never cut a surrogate pair in half; a lone surrogate is not valid UTF-8 output.
  const last = text.charCodeAt(errorValueDisplayLimit - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? errorValueDisplayLimit - 1 : errorValueDisplayLimit;
  return `${text.slice(0, end)}…（已截断，完整值见 report.json）`;
}
