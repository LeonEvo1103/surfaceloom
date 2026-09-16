import { desktopPlatforms, type DesktopPlatform } from "./platform.js";
import type { TraceValue } from "./trace.js";

export const doctorStatuses = ["pass", "warn", "fail", "unsupported"] as const;

export type DoctorStatus = (typeof doctorStatuses)[number];

export interface DoctorCheck {
  readonly id: string;
  readonly summary: string;
  readonly status: DoctorStatus;
  /** A failed required check blocks session creation. */
  readonly required: boolean;
  readonly details?: Readonly<Record<string, TraceValue>>;
  readonly remediation?: string;
}

export interface DoctorReport<P extends DesktopPlatform = DesktopPlatform> {
  readonly schemaVersion: string;
  readonly platform: P;
  readonly targetId?: string;
  readonly generatedAt: string;
  readonly readOnly: true;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorSummary {
  readonly canStartSession: boolean;
  readonly passed: number;
  readonly warnings: number;
  readonly failures: number;
  readonly unsupported: number;
}

export interface ParseDoctorOptions {
  readonly expectedCheckIds?: readonly string[];
}

export function summarizeDoctor(report: DoctorReport): DoctorSummary {
  validateChecks(report.checks);
  const count = (status: DoctorStatus) =>
    report.checks.filter((check) => check.status === status).length;
  const blocked = report.checks.some(
    (check) =>
      check.required && (check.status === "fail" || check.status === "unsupported"),
  );

  return Object.freeze({
    canStartSession: !blocked,
    passed: count("pass"),
    warnings: count("warn"),
    failures: count("fail"),
    unsupported: count("unsupported"),
  });
}

export function parseDoctorReport(
  input: unknown,
  options: ParseDoctorOptions = {},
): DoctorReport {
  const report = requireRecord(input, "doctor report");
  const schemaVersion = requireString(report.schemaVersion, "schemaVersion");
  const platform = requireString(report.platform, "platform");
  if (!desktopPlatforms.includes(platform as DesktopPlatform)) {
    throw new Error(`Unknown doctor platform: ${platform}`);
  }
  const generatedAt = requireString(report.generatedAt, "generatedAt");
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new Error("Doctor generatedAt must be an ISO-compatible timestamp.");
  }
  if (report.readOnly !== true) {
    throw new Error("A doctor report must declare readOnly: true.");
  }
  if (!Array.isArray(report.checks)) {
    throw new Error("Doctor checks must be an array.");
  }
  const checks = report.checks.map(parseCheck);
  validateChecks(checks, options.expectedCheckIds);
  const targetId =
    report.targetId === undefined
      ? undefined
      : requireString(report.targetId, "targetId");

  return Object.freeze({
    schemaVersion,
    platform: platform as DesktopPlatform,
    ...(targetId === undefined ? {} : { targetId }),
    generatedAt,
    readOnly: true,
    checks: Object.freeze(checks),
  });
}

function parseCheck(input: unknown): DoctorCheck {
  const check = requireRecord(input, "doctor check");
  const status = requireString(check.status, "check.status");
  if (!doctorStatuses.includes(status as DoctorStatus)) {
    throw new Error(`Unknown doctor status: ${status}`);
  }
  if (typeof check.required !== "boolean") {
    throw new Error("Doctor check.required must be boolean.");
  }
  const details =
    check.details === undefined
      ? undefined
      : parseDetails(check.details);
  const remediation =
    check.remediation === undefined
      ? undefined
      : requireString(check.remediation, "check.remediation");
  return Object.freeze({
    id: requireString(check.id, "check.id"),
    summary: requireString(check.summary, "check.summary"),
    status: status as DoctorStatus,
    required: check.required,
    ...(details === undefined ? {} : { details }),
    ...(remediation === undefined ? {} : { remediation }),
  });
}

function validateChecks(
  checks: readonly DoctorCheck[],
  expectedCheckIds: readonly string[] = [],
): void {
  if (checks.length === 0) throw new Error("A doctor report must contain checks.");
  const ids = new Set<string>();
  for (const check of checks) {
    if (!doctorStatuses.includes(check.status) || typeof check.required !== "boolean") {
      throw new Error(`Invalid doctor check: ${check.id}`);
    }
    if (ids.has(check.id)) throw new Error(`Duplicate doctor check: ${check.id}`);
    ids.add(check.id);
  }
  for (const expected of expectedCheckIds) {
    if (!ids.has(expected)) throw new Error(`Missing expected doctor check: ${expected}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function parseDetails(value: unknown): Readonly<Record<string, TraceValue>> {
  return parseDetailRecord(
    requireRecord(value, "check.details"),
    0,
    new WeakSet<object>(),
  );
}

function parseDetailRecord(
  value: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
): Readonly<Record<string, TraceValue>> {
  if (depth > 8) throw new Error("Doctor check.details exceeds maximum depth.");
  if (seen.has(value)) throw new Error("Doctor check.details must not be circular.");
  seen.add(value);
  const result = Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        parseDetailValue(item, depth + 1, seen),
      ]),
    ),
  );
  seen.delete(value);
  return result;
}

function parseDetailValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): TraceValue {
  if (depth > 8) throw new Error("Doctor check.details exceeds maximum depth.");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Doctor check.details must not be circular.");
    seen.add(value);
    const result = Object.freeze(
      value.map((item) => parseDetailValue(item, depth + 1, seen)),
    );
    seen.delete(value);
    return result;
  }
  if (typeof value === "object" && value !== null) {
    return parseDetailRecord(value as Record<string, unknown>, depth, seen);
  }
  throw new Error("Doctor check.details must contain JSON-compatible values.");
}
