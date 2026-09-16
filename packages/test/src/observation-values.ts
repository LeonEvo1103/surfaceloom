import type { TraceValue } from "@surfaceloom/core";
import { assertIdentifier } from "./definition.js";
import type { ObservationCompleteness, ObservationSnapshot } from "./observation.js";
import { errorSummary } from "./errors.js";

export function snapshotValue<T extends TraceValue>(value: T): T {
  const seen = new Set<object>();
  let remaining = 10_000;
  function copy(item: unknown, depth: number): TraceValue {
    if (depth > 32 || --remaining < 0) throw new Error("Observation data exceeds snapshot limits.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || seen.has(item)) throw new Error("Observation data must be finite, acyclic JSON data.");
    seen.add(item);
    let result: TraceValue;
    if (Array.isArray(item)) {
      result = Object.freeze(Array.from(item, (value) => copy(value, depth + 1)));
    } else {
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("Observation data must contain plain objects.");
      result = Object.freeze(Object.fromEntries(Object.entries(item).map(([key, value]) => [key, copy(value, depth + 1)])));
    }
    seen.delete(item);
    return result;
  }
  return copy(value, 0) as T;
}

export function evidenceIds(input: readonly string[] = []): readonly string[] {
  if (!Array.isArray(input)) throw new Error("Evidence ids must be an array.");
  const snapshot = [...input];
  for (const id of snapshot) assertIdentifier(id);
  if (new Set(snapshot).size !== snapshot.length) throw new Error("Evidence ids must be unique.");
  return Object.freeze(snapshot);
}

export function snapshotObservation<T extends TraceValue>(input: unknown): ObservationSnapshot<T> {
  if (input === null || typeof input !== "object") throw new Error("A reader must return an observation envelope.");
  const source = input as Record<string, unknown>;
  const metadata = { evidenceIds: evidenceIds(source.evidenceIds as readonly string[] | undefined) };
  switch (source.state) {
    case "available":
      return Object.freeze({ state: "available", value: snapshotValue(source.value as T), ...metadata,
        ...completenessField(source.completeness) });
    case "absent":
      return Object.freeze({ state: "absent", ...metadata, ...completenessField(source.completeness) });
    case "unknown": {
      const reason = source.reason;
      if (typeof reason !== "string" || reason.trim().length === 0) throw new Error("Unknown observations need a reason.");
      return Object.freeze({ state: "unknown", reason, ...metadata });
    }
    case "read-failed":
      return Object.freeze({ state: "read-failed", ...metadata,
        error: snapshotReadFailure(source.error) });
    default:
      throw new Error("Unknown observation state.");
  }
}

function snapshotReadFailure(input: unknown): { readonly code: string; readonly message: string } {
  try {
    if (input !== null && typeof input === "object") {
      const { code, message } = input as Record<string, unknown>;
      if (typeof code === "string" && code.trim().length > 0
          && typeof message === "string" && message.trim().length > 0) {
        return Object.freeze({ code, message });
      }
    }
  } catch { /* Fall back to the existing non-throwing error normalizer. */ }
  return Object.freeze({ code: "readFailed", message: errorSummary("reader", input).message });
}

function completenessField(input: unknown): { readonly completeness?: ObservationCompleteness } {
  if (input === undefined) return {};
  if (input === null || typeof input !== "object") throw new Error("Invalid observation completeness.");
  const proof = input as Record<string, unknown>;
  const kind = proof.kind;
  const complete = proof.complete;
  if (typeof complete !== "boolean") throw new Error("Completeness needs an explicit boolean.");
  if (kind === "barrier") {
    const id = proof.id;
    assertIdentifier(id as string);
    return { completeness: Object.freeze({ kind, id: id as string, complete }) };
  }
  if (kind === "interval") {
    const fromMs = proof.fromMs;
    const toMs = proof.toMs;
    interval(fromMs, toMs);
    return { completeness: Object.freeze({ kind, fromMs: fromMs as number,
      toMs: toMs as number, complete }) };
  }
  throw new Error("Unknown completeness kind.");
}

export function interval(fromMs: unknown, toMs: unknown): void {
  if (typeof fromMs !== "number" || typeof toMs !== "number" || !Number.isFinite(fromMs)
      || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error("A complete interval needs finite fromMs < toMs.");
  }
}
