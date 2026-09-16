import type { TraceValue } from "@surfaceloom/core";
import type { TestErrorSummary } from "@surfaceloom/reporter";

interface StructuredErrorDiagnostic {
  readonly schemaVersion: "surfaceloom.error-diagnostic/v1";
  readonly kind: string;
  readonly data: TraceValue;
  readonly truncated: boolean;
}

const structuredDiagnostics = new WeakMap<object, StructuredErrorDiagnostic>();

/**
 * Attach generic, frozen JSON diagnostics without inspecting arbitrary Error properties.
 * Attachments cap at 24 KiB, 16 levels, 1,024 nodes, 128 array items, 64 object fields,
 * and 2,048 characters per string (8,192 total). Unsupported/accessor, cyclic or
 * excessive data is marked; shortened keys set truncated. First attachment wins.
 */
export function attachErrorDiagnostic(error: object, kind: string, data: unknown): void {
  if (structuredDiagnostics.has(error)) return;
  const snapshot = boundedDiagnostic(data);
  structuredDiagnostics.set(error, Object.freeze({
    schemaVersion: "surfaceloom.error-diagnostic/v1", kind: kind.slice(0, 128),
    data: snapshot.data, truncated: snapshot.truncated,
  }));
}

/** Core places the original setup error first in setup/rollback AggregateErrors. */
export function errorSummary(category: string, error: unknown): TestErrorSummary {
  return Object.freeze({ category, message: messages(error)[0] ?? "Unknown failure." });
}

export function errorDiagnostic(category: string, error: unknown): string {
  const details = error !== null && (typeof error === "object" || typeof error === "function")
    ? structuredDiagnostics.get(error) : undefined;
  const errors = boundedDiagnostic(messages(error));
  return JSON.stringify({ category: category.slice(0, 128), errors: errors.data,
    ...(errors.truncated ? { truncated: true } : {}),
    ...(details === undefined ? {} : { details }),
  });
}

function boundedDiagnostic(input: unknown): { readonly data: TraceValue; readonly truncated: boolean } {
  const seen = new Set<object>();
  let nodes = 1024;
  let characters = 8192;
  let truncated = false;
  const marker = (reason: string): string => { truncated = true; return `[${reason}]`; };
  const copy = (item: unknown, depth: number): TraceValue => {
    if (--nodes < 0 || depth > 16) return marker("TRUNCATED");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string") {
      const limit = Math.min(2048, Math.max(0, characters));
      const text = item.slice(0, limit);
      characters -= text.length;
      return item.length > limit ? text + marker("TRUNCATED") : text;
    }
    if (typeof item !== "object") return marker("UNSUPPORTED");
    if (seen.has(item)) return marker("CIRCULAR");
    seen.add(item);
    try {
      const read = (key: string): TraceValue => {
        try {
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          return descriptor !== undefined && "value" in descriptor
            ? copy(descriptor.value, depth + 1) : marker("UNREADABLE");
        } catch { return marker("UNREADABLE"); }
      };
      if (Array.isArray(item)) {
        const length = Object.getOwnPropertyDescriptor(item, "length")?.value as number;
        const result = Array.from({ length: Math.min(length, 128) }, (_, index) => read(String(index)));
        if (length > 128) result.push(marker("TRUNCATED"));
        return Object.freeze(result);
      }
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) return marker("UNSUPPORTED");
      const keys = Object.keys(item);
      const result = Object.fromEntries(keys.slice(0, 64).map((key) => {
        if (key.length > 128) truncated = true;
        return [key.slice(0, 128), read(key)];
      }));
      if (keys.length > 64) result["$diagnosticTruncated"] = marker("TRUNCATED");
      return Object.freeze(result);
    } catch { return marker("UNREADABLE"); }
    finally { seen.delete(item); }
  };
  let data = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(data)) > 24 * 1024) {
    data = Array.isArray(data) ? Object.freeze([marker("TRUNCATED: diagnostic size")])
      : marker("TRUNCATED: diagnostic size");
  }
  return { data, truncated };
}

function messages(error: unknown, seen = new Set<unknown>(), depth = 0,
  budget = { remaining: 1000 }): string[] {
  if (budget.remaining-- <= 0) return ["Error details exceeded the diagnostic limit."];
  if (depth >= 32) return ["Error nesting exceeded the diagnostic limit."];
  try {
    // Even instanceof can throw when a thrown value is a hostile/revoked Proxy.
    if (error instanceof AggregateError) {
      if (seen.has(error)) return ["Circular AggregateError."];
      const ancestry = new Set([...seen, error]);
      let causes: unknown;
      try { causes = error.errors; } catch {
        return [safeErrorText(error), "AggregateError causes could not be read."];
      }
      if (!Array.isArray(causes)) {
        return [safeErrorText(error), "AggregateError causes were not an array."];
      }
      const result: string[] = [];
      try {
        const count = causes.length;
        for (let index = 0; index < count; index += 1) {
          if (budget.remaining <= 0) {
            result.push("Additional AggregateError causes exceeded the diagnostic limit.");
            break;
          }
          try { result.push(...messages(causes[index], ancestry, depth + 1, budget)); } catch {
            budget.remaining -= 1;
            result.push("An AggregateError cause could not be read.");
          }
        }
      } catch { result.push("AggregateError causes could not be inspected."); }
      return result.length === 0 ? [safeErrorText(error)] : result;
    }
    if (error instanceof Error) return [safeErrorText(error)];
    return [String(error).trim() || "An empty value was thrown."];
  } catch {
    return ["An error value could not be inspected."];
  }
}

function safeErrorText(error: Error): string {
  for (const field of ["message", "name"] as const) {
    try {
      const value: unknown = error[field];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    } catch { /* A broken getter must not interrupt cleanup or hide the failure. */ }
  }
  return "Error details could not be read.";
}
