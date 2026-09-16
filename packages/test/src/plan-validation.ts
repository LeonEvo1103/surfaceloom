import { ExecutionPolicyError } from "./plan-errors.js";

export function invalid(path: string): never {
  throw new ExecutionPolicyError("invalidInput", "plan", { path });
}

/** Read data objects only: a getter must not run while validating a declaration. */
export function record(value: unknown, path: string, keys?: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(path);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path);
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || (keys !== undefined && !keys.includes(key))) invalid(path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid(path);
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

export function items(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 10000) invalid(path);
  const allowed = new Set(["length", ...Array.from({ length: value.length }, (_, i) => String(i))]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) invalid(path);
  const snapshot: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (descriptor === undefined || !("value" in descriptor)) invalid(path);
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

export function choice<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid(path);
  return value as T;
}

export function choices<T extends string>(value: unknown, allowed: readonly T[], path: string): readonly T[] {
  const result = items(value, path).map((item) => choice(item, allowed, path));
  if (new Set(result).size !== result.length) invalid(path);
  return Object.freeze(result);
}

export function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length > 200
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)) invalid(path);
  return value;
}

export function flag(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path);
  return value;
}
