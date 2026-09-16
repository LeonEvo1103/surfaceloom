import type { SafeObject, SafeValue } from "./model.js";

const sensitiveKey = /secret|token|password|authorization|cookie|api[-_]?key|key$|credential|prompt|transcript|conversation|arguments|input|output|content|cwd|path|instruction|encrypted/i;
const safeStringKey = /^(status|outcome|type|event|kind|role|phase|level|surface|client|mode|identitySource|matchedBy|captureStatus|contentType)$/i;
const semanticIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/;
const sourceIdentifier = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
const assignment = /(^|[^A-Za-z0-9_])(["']?)([A-Za-z][A-Za-z0-9_.\/-]{0,127})\2([ \t]*[:=][ \t]*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;{}\[\]"']+)/g;

export function safeObject(value: unknown, depth = 6, seen = new WeakSet<object>()): SafeObject {
  if (!isRecord(value)) return Object.freeze({});
  if (seen.has(value)) return Object.freeze({ circular: "[CIRCULAR]" });
  seen.add(value);
  const result = Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      cleanText(key),
      sensitiveKey.test(key) ? "[REDACTED]" : safeValue(item, depth - 1, safeStringKey.test(key), seen),
    ]),
  ));
  seen.delete(value);
  return result;
}

export function safeValue(value: unknown, depth = 6, allowString = false, seen = new WeakSet<object>()): SafeValue {
  if (depth < 0) return "[TRUNCATED]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const cleaned = cleanText(value);
    return allowString && semanticIdentifier.test(cleaned) ? cleaned : "[REDACTED]";
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const result = Object.freeze(value.slice(0, 100).map((item) => safeValue(item, depth - 1, allowString, seen)));
    seen.delete(value);
    return result;
  }
  if (isRecord(value)) return safeObject(value, depth, seen);
  return `[${typeof value}]`;
}

export function safeIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = cleanText(value).trim();
  return semanticIdentifier.test(cleaned) ? cleaned : fallback;
}

export function safeOptionalIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = cleanText(value).trim();
  return semanticIdentifier.test(cleaned) ? cleaned : undefined;
}

export function isSemanticIdentifier(value: unknown): value is string {
  return typeof value === "string" && semanticIdentifier.test(value);
}

export function isAgentLoopSource(value: unknown): value is string {
  return typeof value === "string" && sourceIdentifier.test(value);
}

export function cleanText(value: string): string {
  return redactCredentialAssignments(value)
    .replace(/\b((?:proxy-)?authorization|cookie|set-cookie)[ \t]*:[ \t]*[^\r\n]*/gi, "$1: [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\b((?:api[-_]?key|token|password|secret|authorization|cookie))\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/([?&](?:access[_-]?token|api[_-]?key|signature|sig|code|key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\/Users\/[^/\s]+/g, "/Users/[REDACTED]")
    .replace(/\/home\/[^/\s]+/g, "/home/[REDACTED]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, "C:\\Users\\[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

function redactCredentialAssignments(value: string): string {
  assignment.lastIndex = 0;
  return value.replace(assignment, (whole, boundary: string, quote: string, key: string, separator: string) =>
    isCredentialKey(key)
      ? `${boundary}${quote}${key}${quote}${separator}"[REDACTED]"`
      : whole,
  );
}

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_./-]+/g, "");
  return /(?:token|password|passwd|secret|authorization|cookie|credential|credentials|apikey|privatekey|secretkey|accesskeyid)$/.test(normalized);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  return typeof item === "string" ? item : undefined;
}

export function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}
