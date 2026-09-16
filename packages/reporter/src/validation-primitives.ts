import type { TestStatus } from "./model.js";
import { redactReportText } from "./redact.js";

const statuses = new Set<TestStatus>([
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "unsupported",
]);

export function validateStatus(value: TestStatus): void {
  if (!statuses.has(value)) throw new Error("Unknown test status.");
}

export function validateDuration(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number.`);
  }
}

export function validateTimestamp(label: string, value: string): number {
  const iso8601 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
  const match = iso8601.exec(value);
  if (match === null) throw new Error(`${label} must be an ISO timestamp.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  const monthDays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]!
      || hour > 23 || minute > 59 || second > 59
      || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(`${label} must be a valid ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp.`);
  return parsed;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function validateNonEmpty(label: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`A ${label} must not be empty.`);
}

export function validateIdentifier(label: string, value: string): void {
  validateNonEmpty(label, value);
  if (value.length > 200) throw new Error(`A ${label} must not exceed 200 characters.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)) {
    throw new Error(`A ${label} must use the stable machine-id character set.`);
  }
  if (redactReportText(value) !== value) {
    throw new Error(`A ${label} must not contain credential-like data.`);
  }
}

export function validateUnique(label: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}.`);
    seen.add(value);
  }
}
