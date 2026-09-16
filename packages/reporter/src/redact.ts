import type { TraceValue } from "@surfaceloom/core";
import os from "node:os";

const sensitiveAssignment = new RegExp(
  String.raw`(^|[^A-Za-z0-9_])((?:["'])?([A-Za-z][A-Za-z0-9_./-]{0,127})(?:["'])?[ \t]*[:=][ \t]*)`,
  "gu",
);

const sensitiveHeader = /\b((?:proxy-)?authorization|cookie|set-cookie)[ \t]*:[ \t]*[^\r\n]*/gi;
const nextAssignment = /(?:["']?[A-Za-z][A-Za-z0-9_./-]{0,127}["']?[ \t]*[:=])/uy;
const redactedMarker = "[REDACTED]";

const highConfidenceSecrets = [
  /\b(?:gh[pour]_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9_.-]{12,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g,
  /\bwhsec_[A-Za-z0-9]{12,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
] as const;

const credentialKeySuffixes = [
  "token",
  "password",
  "passwd",
  "secret",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "apikey",
  "privatekey",
  "secretkey",
  "secretaccesskey",
  "accesskeyid",
] as const;

export function redactReportText(value: string): string {
  let redacted = redactAssignments(
    value.replace(sensitiveHeader, "$1: [REDACTED]"),
  )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [REDACTED]");
  for (const pattern of highConfidenceSecrets) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  redacted = redacted
    .replace(/\/Users\/[^/\s]+/g, "$USER_HOME")
    .replace(/\/home\/[^/\s]+/g, "$USER_HOME")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, "%USERPROFILE%");
  const currentHome = os.homedir().replace(/[\\/]+$/u, "");
  return currentHome.length <= 1
    ? redacted
    : redacted.split(currentHome).join("$USER_HOME");
}

function redactAssignments(value: string): string {
  let output = "";
  let cursor = 0;
  sensitiveAssignment.lastIndex = 0;
  for (let match = sensitiveAssignment.exec(value); match !== null;
    match = sensitiveAssignment.exec(value)) {
    const [whole, boundary, keyAndSeparator, key] = match;
    if (!isCredentialKey(key!)) {
      sensitiveAssignment.lastIndex = Math.max(
        match.index + whole.length - 1,
        match.index + 1,
      );
      continue;
    }
    const sensitiveValue = readSensitiveValue(value, match.index + whole.length);
    if (sensitiveValue === undefined) continue;
    output += value.slice(cursor, match.index);
    output += `${boundary!}${keyAndSeparator!}${sensitiveValue.replacement}`;
    cursor = sensitiveValue.end;
    sensitiveAssignment.lastIndex = sensitiveValue.end;
  }
  return output + value.slice(cursor);
}

function readSensitiveValue(
  value: string,
  start: number,
): { readonly end: number; readonly replacement: string } | undefined {
  if (start >= value.length || value[start] === "\n" || value[start] === "\r") return undefined;
  if (value.startsWith(redactedMarker, start)) {
    return {
      end: markerValueEnd(value, start + redactedMarker.length),
      replacement: redactedMarker,
    };
  }
  const first = value[start]!;
  if (first === '"' || first === "'") {
    return { end: quotedValueEnd(value, start, first), replacement: `${first}${redactedMarker}${first}` };
  }
  if (first === "{" || first === "[" || first === "(") {
    return { end: structuredValueEnd(value, start), replacement: `"${redactedMarker}"` };
  }
  const end = unquotedValueEnd(value, start);
  return end === start ? undefined : { end, replacement: redactedMarker };
}

function markerValueEnd(value: string, markerEnd: number): number {
  if (markerEnd >= value.length) return markerEnd;
  const character = value[markerEnd]!;
  if ("\r\n,;&}]".includes(character)) return markerEnd;
  if (character === '"' || character === "'") {
    const next = value[markerEnd + 1];
    if (next === undefined || "\r\n,;&}] \t".includes(next)) return markerEnd;
  }
  if (/[\t ]/u.test(character)) {
    let next = markerEnd;
    while (next < value.length && /[\t ]/u.test(value[next]!)) next += 1;
    if (next >= value.length || value[next] === "\r" || value[next] === "\n") return markerEnd;
    nextAssignment.lastIndex = next;
    if (nextAssignment.test(value)) return markerEnd;
  }
  const lineBreak = value.slice(markerEnd).search(/[\r\n]/u);
  return lineBreak === -1 ? value.length : markerEnd + lineBreak;
}

function quotedValueEnd(value: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "\n" || character === "\r") return index;
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === quote) return index + 1;
  }
  return value.length;
}

function structuredValueEnd(value: string, start: number): number {
  const firstCloser = value[start] === "{" ? "}" : value[start] === "[" ? "]" : ")";
  const closers = [firstCloser];
  let quote = "";
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote !== "") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "{") closers.push("}");
    else if (character === "[") closers.push("]");
    else if (character === "(") closers.push(")");
    else if (character === closers.at(-1)) {
      closers.pop();
      if (closers.length === 0) return index + 1;
    }
  }
  return value.length;
}

function unquotedValueEnd(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if ("\r\n,;&}]\"'".includes(character)) return index;
    if (/\s/u.test(character)) {
      let next = index;
      while (next < value.length && /[\t ]/u.test(value[next]!)) next += 1;
      nextAssignment.lastIndex = next;
      if (nextAssignment.test(value)) return index;
    }
  }
  return value.length;
}

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_./-]+/g, "");
  return credentialKeySuffixes.some(
    (suffix) => normalized.endsWith(suffix)
      || normalized.endsWith(`${suffix}value`)
      || normalized.endsWith(`${suffix}hash`),
  );
}

export function redactTraceValue(value: TraceValue, depth = 8): TraceValue {
  if (typeof value === "string") return redactReportText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth <= 0) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => redactTraceValue(item, depth - 1)));
  }
  const usedKeys = new Set<string>();
  const entries = Object.entries(value).map(([key, item], index) => {
    const candidate = redactReportText(key);
    let safeKey = candidate;
    if (usedKeys.has(safeKey)) {
      safeKey = `field-${index}`;
      let suffix = 1;
      while (usedKeys.has(safeKey)) safeKey = `field-${index}-${suffix++}`;
    }
    usedKeys.add(safeKey);
    return [
      safeKey,
      isCredentialKey(key)
        || /prompt|transcript|conversation/i.test(key)
        ? "[REDACTED]"
        : redactTraceValue(item, depth - 1),
    ];
  });
  return Object.freeze(Object.fromEntries(entries));
}
