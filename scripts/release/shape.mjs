import { types } from "node:util";
import { isSha256 } from "./digest.mjs";

export class ReleaseContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseContractError";
    this.code = code;
  }
}

export function record(value, label, allowed, required = allowed) {
  if (types.isProxy(value) || value === null || typeof value !== "object"
      || Array.isArray(value)) fail("invalidRecord", `${label} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("invalidRecord", `${label} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      fail("unexpectedField", `${label} contains unexpected field ${String(key)}.`);
    }
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) fail("accessor", `${label}.${key} must be a data property.`);
    output[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(output, key)) fail("missingField", `${label}.${key} is required.`);
  }
  return output;
}

export function dictionary(value, label) {
  if (types.isProxy(value) || value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalidRecord", `${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("invalidRecord", `${label} must be a plain object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !("value" in descriptors[key])) {
      fail("invalidRecord", `${label} must contain only string data properties.`);
    }
    output[key] = descriptors[key].value;
  }
  return output;
}

export function list(value, label, { min = 0 } = {}) {
  if (types.isProxy(value) || !Array.isArray(value)) fail("invalidArray", `${label} must be an array.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < min) fail("invalidArray", `${label} has invalid length.`);
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (descriptor === undefined || !("value" in descriptor)) {
      fail("invalidArray", `${label}[${index}] must be an own data property.`);
    }
    output.push(descriptor.value);
  }
  return output;
}

export function string(value, label, pattern) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
      || (pattern !== undefined && !pattern.test(value))) {
    fail("invalidString", `${label} is invalid.`);
  }
  return value;
}

export function integer(value, label, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) fail("invalidInteger", `${label} is invalid.`);
  return value;
}

export function oneOf(value, values, label) {
  if (!values.includes(value)) fail("invalidEnum", `${label} is unsupported.`);
  return value;
}

export function digest(value, label) {
  const item = record(value, label, ["algorithm", "value"]);
  if (item.algorithm !== "sha256" || !isSha256(item.value)) {
    fail("invalidDigest", `${label} must contain a non-zero SHA-256 digest.`);
  }
  return item;
}

export function uniqueStrings(value, label, { min = 0 } = {}) {
  const values = list(value, label, { min }).map((entry, index) => string(entry, `${label}[${index}]`));
  if (new Set(values).size !== values.length) fail("duplicateValue", `${label} contains duplicates.`);
  return values;
}

export function assertNoPendingOrSecrets(value, label = "manifest", seen = new Set()) {
  if (value === "pending") fail("pendingFact", `${label} contains pending instead of a final fact.`);
  if (value === null || typeof value !== "object") return;
  if (types.isProxy(value) || seen.has(value)) fail("invalidGraph", `${label} contains a proxy or cycle.`);
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !("value" in descriptors[key])) {
      fail("invalidGraph", `${label} contains an accessor or symbol.`);
    }
    if (/(?:secret|private.?key|password|token|credential)/iu.test(key)) {
      fail("secretMaterial", `${label} must never contain secret material.`);
    }
    assertNoPendingOrSecrets(descriptors[key].value, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

export function sameJson(left, right, seen = new WeakMap()) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (seen.get(left) === right) return true;
  seen.set(left, right);
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((entry, index) => sameJson(entry, right[index], seen));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(left[key], right[key], seen));
}

export function fail(code, message) {
  throw new ReleaseContractError(code, message);
}
