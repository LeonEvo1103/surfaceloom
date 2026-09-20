import { types } from "node:util";

export const safeDataLimits = Object.freeze({
  maxDepth: 64,
  maxNodes: 10_000,
  maxStringBytes: 1_048_576,
  maxCollectionEntries: 1_024,
});

export type SafeDataErrorCode =
  | "accessor"
  | "budget"
  | "cycle-or-shared-reference"
  | "invalid-number"
  | "proxy"
  | "unsupported-data";

export class SafeDataError extends TypeError {
  readonly code: SafeDataErrorCode;
  readonly path: string;

  constructor(code: SafeDataErrorCode, path: string, message: string) {
    super(message);
    this.name = "SafeDataError";
    this.code = code;
    this.path = path;
  }
}

/**
 * Copies a bounded JSON-like tree without invoking accessors or Proxy traps.
 * Cycles and shared object references are rejected instead of expanded.
 */
export function cloneSafeData<T>(value: T): T {
  const state: CloneState = { nodes: 0, stringBytes: 0, seen: new WeakSet<object>() };
  return clone(value, state, "value", 0) as T;
}

/** Reads only one plain-object level; nested values remain untouched. */
export function readSafeRecordEnvelope(input: unknown, path: string): Record<string, unknown> {
  assertNonProxyObject(input, path);
  if (Array.isArray(input) || !isPlainRecord(input)) {
    throw unsafe("unsupported-data", path, `${path} must be a plain object.`);
  }
  return copyRecordDescriptors(input, path, safeDataLimits.maxCollectionEntries);
}

/** Reads a bounded plain array through descriptors, never through iteration. */
export function readSafeArrayEnvelope(
  input: unknown,
  path: string,
  maxItems: number = safeDataLimits.maxCollectionEntries,
): readonly unknown[] {
  assertNonProxyObject(input, path);
  if (!Array.isArray(input)) {
    throw unsafe("unsupported-data", path, `${path} must be a plain array.`);
  }
  return copyArrayDescriptors(input, path, maxItems);
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

interface CloneState {
  nodes: number;
  stringBytes: number;
  readonly seen: WeakSet<object>;
}

function clone(value: unknown, state: CloneState, path: string, depth: number): unknown {
  spendNode(state, path);
  if (depth > safeDataLimits.maxDepth) {
    throw unsafe("budget", path, `${path} exceeds the safe-data depth budget.`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    spendString(state, value, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw unsafe("invalid-number", path, `${path} is not finite.`);
    return value;
  }
  if (typeof value !== "object") {
    throw unsafe("unsupported-data", path, `${path} contains unsupported data.`);
  }
  assertNonProxyObject(value, path);
  if (state.seen.has(value)) {
    throw unsafe(
      "cycle-or-shared-reference",
      path,
      `${path} contains a cycle or shared object reference.`,
    );
  }
  state.seen.add(value);

  if (Array.isArray(value)) {
    const source = copyArrayDescriptors(value, path, safeDataLimits.maxCollectionEntries);
    return source.map((item, index) => clone(item, state, `${path}[${index}]`, depth + 1));
  }
  if (!isPlainRecord(value)) {
    throw unsafe("unsupported-data", path, `${path} must contain only plain objects and arrays.`);
  }
  const source = copyRecordDescriptors(value, path, safeDataLimits.maxCollectionEntries);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    spendString(state, key, `${path} key`);
    Object.defineProperty(result, key, {
      value: clone(item, state, `${path}.${key}`, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function copyArrayDescriptors(value: unknown[], path: string, maxItems: number): unknown[] {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
    throw unsafe("accessor", path, `${path}.length must be a data property.`);
  }
  const length = lengthDescriptor.value as number;
  if (length > maxItems) throw unsafe("budget", path, `${path} exceeds its item budget.`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) {
    throw unsafe("unsupported-data", path, `${path} must be dense and have no extra properties.`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      throw unsafe("unsupported-data", itemPath, `${path} must not contain array holes.`);
    }
    assertDataDescriptor(descriptor, itemPath);
    result.push(descriptor.value);
  }
  return result;
}

function copyRecordDescriptors(value: object, path: string, maxFields: number): Record<string, unknown> {
  const keys = Reflect.ownKeys(value);
  if (keys.length > maxFields) throw unsafe("budget", path, `${path} exceeds its field budget.`);
  if (keys.some((key) => typeof key === "symbol")) {
    throw unsafe("unsupported-data", path, `${path} must not contain symbol properties.`);
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const stringKey = key as string;
    const descriptor = Object.getOwnPropertyDescriptor(value, stringKey);
    if (descriptor === undefined) {
      throw unsafe("unsupported-data", `${path}.${stringKey}`, `${path}.${stringKey} is not readable.`);
    }
    assertDataDescriptor(descriptor, `${path}.${stringKey}`);
    Object.defineProperty(result, stringKey, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function assertDataDescriptor(descriptor: PropertyDescriptor, path: string): void {
  if (!("value" in descriptor)) {
    throw unsafe("accessor", path, `${path} must be a data property; accessors are not allowed.`);
  }
  if (descriptor.enumerable !== true) {
    throw unsafe("unsupported-data", path, `${path} must be enumerable.`);
  }
}

function assertNonProxyObject(value: unknown, path: string): asserts value is object {
  if (typeof value !== "object" || value === null) {
    throw unsafe("unsupported-data", path, `${path} must be an object.`);
  }
  if (types.isProxy(value)) throw unsafe("proxy", path, `${path} must not contain a Proxy.`);
}

function isPlainRecord(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function spendNode(state: CloneState, path: string): void {
  state.nodes += 1;
  if (state.nodes > safeDataLimits.maxNodes) {
    throw unsafe("budget", path, `${path} exceeds the safe-data node budget.`);
  }
}

function spendString(state: CloneState, value: string, path: string): void {
  state.stringBytes += Buffer.byteLength(value, "utf8");
  if (state.stringBytes > safeDataLimits.maxStringBytes) {
    throw unsafe("budget", path, `${path} exceeds the safe-data string-byte budget.`);
  }
}

function unsafe(code: SafeDataErrorCode, path: string, message: string): SafeDataError {
  return new SafeDataError(code, path, message);
}
