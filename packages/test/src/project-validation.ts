import { types } from "node:util";

export class ProjectConfigurationError extends Error {
  readonly exitCode = 2 as const;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProjectConfigurationError";
  }
}

export function plainRecord(value: unknown, label: string,
  allowed: readonly string[]): Readonly<Record<string, unknown>> {
  if (types.isProxy(value)) invalid("proxyRejected", `${label} must not be a Proxy.`);
  try {
    if (value === null || typeof value !== "object") invalid("invalidRecord", `${label} must be a plain object.`);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid("invalidRecord", `${label} must be a plain object.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || !allowed.includes(key)) {
        invalid("unexpectedField", `${label} contains an unexpected field.`);
      }
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor)) invalid("accessorField", `${label} fields must not be accessors.`);
    }
    return Object.freeze(Object.fromEntries(Object.entries(descriptors)
      .map(([key, descriptor]) => [key, descriptor.value])));
  } catch (error) {
    if (error instanceof ProjectConfigurationError) throw error;
    invalid("unreadableRecord", `${label} could not be inspected.`);
  }
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    invalid("invalidString", `${label} must be a nonempty string without NUL bytes.`);
  }
  return value;
}

export function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    invalid("invalidInteger", `${label} must be a positive safe integer.`);
  }
  return value as number;
}

export function stringArray(value: unknown, label: string): readonly string[] {
  if (types.isProxy(value)) invalid("proxyRejected", `${label} must not be a Proxy.`);
  if (!Array.isArray(value)) {
    invalid("invalidArray", `${label} must be a nonempty array.`);
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
      ? lengthDescriptor.value : undefined;
    if (!Number.isSafeInteger(length) || (length as number) <= 0) {
      invalid("invalidArray", `${label} must be a nonempty array.`);
    }
    const result: string[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) {
        invalid("accessorField", `${label} entries must be own data properties.`);
      }
      result.push(stringValue(descriptor.value, `${label}[${index}]`));
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof ProjectConfigurationError) throw error;
    invalid("unreadableArray", `${label} could not be inspected.`);
  }
}

export function safeErrorMessage(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (descriptor !== undefined && "value" in descriptor
          && typeof descriptor.value === "string" && descriptor.value.length > 0) {
        return descriptor.value;
      }
    }
    if (typeof error === "string" && error.length > 0) return error;
  } catch { /* Use a bounded fallback. */ }
  return "Project loading failed with an unreadable error.";
}

function invalid(code: string, message: string): never {
  throw new ProjectConfigurationError(code, message);
}
