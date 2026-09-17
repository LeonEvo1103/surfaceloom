import type { TraceValue } from "@surfaceloom/core";
import { types } from "node:util";

/** Getter-free JSON snapshot used before redaction and byte accounting. */
export function jsonSnapshot(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
  depth = 0,
): TraceValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new Error(`${label} is not valid JSON data.`);
  // isProxy does not invoke user traps. Reject before prototype/descriptors can execute them.
  if (types.isProxy(value)) throw new Error(`${label} must not contain a Proxy.`);
  if (depth > 32 || seen.has(value)) throw new Error(`${label} is cyclic or too deeply nested.`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must contain only plain JSON objects.`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) return snapshotArray(value, label, seen, depth);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
      throw new Error(`${label} contains a symbol key.`);
    }
    const result: Record<string, TraceValue> = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`${label}.${key} is not a JSON data field.`);
      }
      result[key] = jsonSnapshot(descriptor.value, `${label}.${key}`, seen, depth + 1);
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}

function snapshotArray(
  value: readonly unknown[],
  label: string,
  seen: WeakSet<object>,
  depth: number,
): TraceValue {
  if (value.length > 10_000) throw new Error(`${label} exceeds its array limit.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => key !== "length"
      && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)))) {
    throw new Error(`${label} contains a custom array field.`);
  }
  const result: TraceValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label}[${index}] is not a JSON data field.`);
    }
    result.push(jsonSnapshot(descriptor.value, `${label}[${index}]`, seen, depth + 1));
  }
  return Object.freeze(result);
}
