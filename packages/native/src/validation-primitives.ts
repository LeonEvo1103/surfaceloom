import type { JsonObject, JsonValue } from "./contracts.js";
import { NativeProtocolError } from "./protocol-error.js";

export function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) invalid(`${label}.${key} must be an enumerable data field.`);
    if (!keys.includes(key)) invalid(`${label} contains unknown field '${key}'.`);
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

export function required(input: Record<string, unknown>, key: string, label: string): unknown {
  if (!Object.hasOwn(input, key)) invalid(`${label}.${key} is required.`);
  return input[key];
}

export function text(value: unknown, label: string, maximum = 128): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximum
    || value.includes("\0") || /[\r\n]/u.test(value)) invalid(`${label} is not a bounded single-line string.`);
  return value;
}

export function identifier(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u.test(result)) invalid(`${label} is not a wire identifier.`);
  return result;
}

export function choice<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) invalid(`${label} is not a supported value.`);
  return value as T[number];
}

export function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function arrayValues(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`);
  if (Reflect.ownKeys(value).some((key) => key !== "length"
      && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)))) {
    invalid(`${label} must not contain custom properties.`);
  }
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      invalid(`${label}[${index}] must be an enumerable data item.`);
    }
    items.push(descriptor.value);
  }
  return items;
}

export function jsonValue(value: unknown, label: string, depth = 0): JsonValue {
  if (depth > 32) invalid(`${label} exceeds the JSON nesting limit.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(arrayValues(value, label)
    .map((item, index) => jsonValue(item, `${label}[${index}]`, depth + 1)));
  if (typeof value !== "object") invalid(`${label} must contain only JSON values.`);
  const input = record(value, label, Object.keys(value as object));
  return Object.freeze(Object.fromEntries(Object.entries(input)
    .map(([key, item]) => [key, jsonValue(item, `${label}.${key}`, depth + 1)]))) as JsonObject;
}

export function invalid(message: string): never {
  throw new NativeProtocolError("invalid_message", message);
}
