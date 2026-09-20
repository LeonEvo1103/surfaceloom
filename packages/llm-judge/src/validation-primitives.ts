import { JudgeContractError } from "./contracts.js";
import { types } from "node:util";

export interface DataBudget {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

interface WalkState {
  nodes: number;
  bytes: number;
  readonly seen: WeakSet<object>;
}

export const REQUEST_DATA_BUDGET: DataBudget = Object.freeze({
  maxDepth: 16,
  maxNodes: 20_000,
  maxBytes: 20 * 1024 * 1024,
});

export const OUTCOME_DATA_BUDGET: DataBudget = Object.freeze({
  maxDepth: 16,
  maxNodes: 10_000,
  maxBytes: 2 * 1024 * 1024,
});

export const FAKE_DATA_BUDGET: DataBudget = Object.freeze({
  maxDepth: 18,
  maxNodes: 30_000,
  maxBytes: 20 * 1024 * 1024,
});

function spend(state: WalkState, budget: DataBudget, path: string, bytes: number): void {
  state.nodes += 1;
  state.bytes += bytes;
  if (state.nodes > budget.maxNodes) throw new JudgeContractError(path, "exceeds data node budget");
  if (state.bytes > budget.maxBytes) throw new JudgeContractError(path, "exceeds data byte budget");
}

function ownDataDescriptors(value: object, path: string): Record<PropertyKey, PropertyDescriptor> {
  if (types.isProxy(value)) throw new JudgeContractError(path, "must not be a Proxy");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") throw new JudgeContractError(path, "must not contain symbol keys");
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new JudgeContractError(`${path}.${key}`, "must be a data property, not an accessor");
    }
  }
  return descriptors;
}

function copyData(
  value: unknown,
  path: string,
  budget: DataBudget,
  state: WalkState,
  depth: number,
): unknown {
  if (depth > budget.maxDepth) throw new JudgeContractError(path, "exceeds data depth budget");
  if (value === null || value === undefined || typeof value === "boolean") {
    spend(state, budget, path, 0);
    return value;
  }
  if (typeof value === "string") {
    spend(state, budget, path, Buffer.byteLength(value));
    return value;
  }
  if (typeof value === "number") {
    spend(state, budget, path, 8);
    return value;
  }
  if (typeof value !== "object") throw new JudgeContractError(path, "contains an unsupported value type");
  if (state.seen.has(value)) throw new JudgeContractError(path, "must not contain cycles or repeated object aliases");
  state.seen.add(value);
  spend(state, budget, path, 0);
  const descriptors = ownDataDescriptors(value, path);
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new JudgeContractError(path, "must have the standard Array prototype");
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > budget.maxNodes) {
      throw new JudgeContractError(`${path}.length`, "is outside the data node budget");
    }
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (keys.length !== length) throw new JudgeContractError(path, "must be a dense array without extra properties");
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined) throw new JudgeContractError(`${path}[${index}]`, "sparse arrays are not allowed");
      copy.push(copyData(descriptor.value, `${path}[${index}]`, budget, state, depth + 1));
    }
    return Object.freeze(copy);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new JudgeContractError(path, "must have a plain or null prototype");
  }
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(descriptors)) {
    spend(state, budget, `${path}.${key}`, Buffer.byteLength(key));
    copy[key] = copyData(descriptors[key]!.value, `${path}.${key}`, budget, state, depth + 1);
  }
  return Object.freeze(copy);
}

/** Copies untrusted data without invoking getters or Proxy traps and freezes the copy. */
export function sanitizeUntrusted(value: unknown, path: string, budget: DataBudget): unknown {
  return copyData(value, path, budget, { nodes: 0, bytes: 0, seen: new WeakSet() }, 0);
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JudgeContractError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new JudgeContractError(`${path}.${unexpected}`, "is not allowed");
  }
}

export function text(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") throw new JudgeContractError(path, "must be a string");
  const normalized = value.trim();
  if (normalized.length === 0) throw new JudgeContractError(path, "must not be empty");
  if (normalized.length > max) throw new JudgeContractError(path, `exceeds ${max} characters`);
  return normalized;
}

export function identifier(value: unknown, path: string): string {
  const normalized = text(value, path, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    throw new JudgeContractError(path, "must be a stable identifier");
  }
  return normalized;
}

export function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new JudgeContractError(path, "must be an array");
  if (value.length > max) throw new JudgeContractError(path, `exceeds ${max} items`);
  return value;
}

export function finiteInteger(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new JudgeContractError(path, `must be an integer from 0 through ${max}`);
  }
  return value as number;
}

export function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new JudgeContractError(path, "must not contain duplicates");
  }
}
