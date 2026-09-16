export interface CorrelationSnapshotLimits {
  readonly maxDataUnits: number;
  readonly maxTraces: number;
  readonly maxEvents: number;
  readonly maxBindings: number;
}

interface SnapshotState {
  remaining: number;
  events: number;
  readonly limits: CorrelationSnapshotLimits;
}

/** Copies data descriptors once so validation never evaluates user getters. */
export function snapshotCorrelationData(
  value: unknown,
  label: string,
  limits: CorrelationSnapshotLimits,
): unknown {
  return snapshotValue(value, label, {
    remaining: limits.maxDataUnits,
    events: 0,
    limits,
  });
}

function snapshotValue(
  value: unknown,
  label: string,
  state: SnapshotState,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  state.remaining -= 1;
  if (state.remaining < 0) {
    throw new Error("Agent-loop correlation input exceeds the maximum data budget.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return value;
  }
  if (typeof value !== "object") throw new Error(`${label} contains a non-data value.`);
  if (depth > 24) throw new Error(`${label} exceeds the maximum depth.`);
  if (seen.has(value)) throw new Error(`${label} contains a cycle.`);
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
      throw new Error(`${label} contains a symbol property.`);
    }
    if (Array.isArray(value)) return snapshotArray(descriptors, label, state, seen, depth);
    if (Reflect.ownKeys(descriptors).length > 1_000) {
      throw new Error(`${label} exceeds the maximum object width.`);
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain objects.`);
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`${label}.${key} must be an enumerable data field.`);
      }
      result[key] = snapshotValue(
        descriptor.value, `${label}.${key}`, state, seen, depth + 1,
      );
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}

function snapshotArray(
  descriptors: PropertyDescriptorMap,
  label: string,
  state: SnapshotState,
  seen: WeakSet<object>,
  depth: number,
): readonly unknown[] {
  const lengthDescriptor = descriptors.length;
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    throw new Error(`${label} has an invalid array length.`);
  }
  const length = lengthDescriptor.value as number;
  if (label === "agent-loop correlation input.traces"
      && length > state.limits.maxTraces) {
    throw new Error("Agent-loop correlation input exceeds the maximum trace count.");
  }
  if (label === "agent-loop correlation input.bindings"
      && length > state.limits.maxBindings) {
    throw new Error("Agent-loop correlation input exceeds the maximum binding count.");
  }
  if (/\.traces\[(?:0|[1-9][0-9]*)\]\.events$/u.test(label)) {
    state.events += length;
    if (state.events > state.limits.maxEvents) {
      throw new Error("Agent-loop correlation input exceeds the maximum total event count.");
    }
  }
  if (length > 10_000) throw new Error(`${label} exceeds the maximum array length.`);
  const keys = Object.keys(descriptors).filter((key) => key !== "length");
  if (keys.some((key) => !/^(?:0|[1-9][0-9]*)$/u.test(key))) {
    throw new Error(`${label} array contains a custom property.`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label}[${index}] must be an enumerable data item.`);
    }
    result.push(snapshotValue(
      descriptor.value, `${label}[${index}]`, state, seen, depth + 1,
    ));
  }
  return Object.freeze(result);
}
