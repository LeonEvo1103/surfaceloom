import path from "node:path";
import { types } from "node:util";

import { WindowsNativeError } from "./error.js";
import type { WindowsDesktopCapability, WindowsUiaLocator, WindowsWaitOptions } from "./contracts.js";

const stablePattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u;
const capabilitySet = new Set<WindowsDesktopCapability>([
  "app.launch", "app.attach", "app.quit", "app.terminate", "ui.inspect", "ui.invoke", "ui.set-value",
]);

export function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || !stablePattern.test(value)) {
    throw invalid(`${label} must be a stable identifier.`);
  }
  return value;
}

export function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    throw invalid(`${label} must be an explicit absolute path.`);
  }
  return value;
}

export function timeout(value: unknown, fallback = 5_000): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved < 0 || resolved > 120_000) {
    throw new WindowsNativeError("deadline", "Windows native timeout must be between 0 and 120000 ms.");
  }
  return resolved;
}

export function waitOptions(value: Partial<WindowsWaitOptions> | undefined,
  maximumMs: number): WindowsWaitOptions {
  const timeoutMs = Math.min(timeout(value?.timeoutMs, maximumMs), maximumMs);
  const pollIntervalMs = value?.pollIntervalMs ?? 100;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 5_000) {
    throw invalid("Windows wait pollIntervalMs must be between 10 and 5000 ms.");
  }
  return Object.freeze({ timeoutMs, pollIntervalMs });
}

export function capabilities(values: readonly WindowsDesktopCapability[] | undefined):
readonly WindowsDesktopCapability[] {
  const source = values ?? [...capabilitySet];
  if (!Array.isArray(source) || types.isProxy(source)) throw invalid("Capabilities must be a plain array.");
  const result = source.map((value) => {
    if (!capabilitySet.has(value)) throw invalid(`Unsupported Windows capability '${String(value)}'.`);
    return value;
  });
  if (new Set(result).size !== result.length) throw invalid("Windows capabilities must be unique.");
  return Object.freeze(result);
}

export function locator(value: WindowsUiaLocator): WindowsUiaLocator {
  const input = exactRecord(value, "locator", ["automationIds", "names", "controlTypes", "classNames",
    "frameworkIds", "nativeWindowHandle", "scope", "matchIndex"]);
  const result = Object.freeze({
    automationIds: stringArray(input.automationIds, "locator.automationIds"),
    names: stringArray(input.names, "locator.names"),
    controlTypes: stringArray(input.controlTypes, "locator.controlTypes"),
    classNames: stringArray(input.classNames, "locator.classNames"),
    frameworkIds: stringArray(input.frameworkIds, "locator.frameworkIds"),
    nativeWindowHandle: nullableInteger(input.nativeWindowHandle, "locator.nativeWindowHandle", 1),
    scope: choice(input.scope, ["element", "children", "descendants", "subtree"] as const, "locator.scope"),
    matchIndex: nullableInteger(input.matchIndex, "locator.matchIndex", 0),
  });
  const selectorCount = result.automationIds.length + result.names.length + result.controlTypes.length
    + result.classNames.length + result.frameworkIds.length + (result.nativeWindowHandle === null ? 0 : 1);
  if (selectorCount === 0) throw invalid("Windows locator must contain at least one stable selector.");
  return result;
}

export function strictLocator(value: WindowsUiaLocator): WindowsUiaLocator {
  const result = locator(value);
  if (result.matchIndex !== null) {
    throw invalid("Strict Windows actions do not accept matchIndex; refine the locator instead.");
  }
  return result;
}

export function exactRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value)) throw invalid(`${label} must be plain data.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid(`${label} must be plain data.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw invalid(`${label} contains unknown fields.`);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw invalid(`${label}.${key} must be an enumerable data property.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function stringValue(value: unknown, label: string, allowEmpty = true): string {
  if (typeof value !== "string" || value.includes("\0") || (!allowEmpty && value.length === 0)) {
    throw invalid(`${label} must be a${allowEmpty ? "" : " non-empty"} string.`);
  }
  return value;
}

export function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > 256) throw invalid(`${label} must be a bounded array.`);
  const result = value.map((item, index) => stringValue(item, `${label}[${index}]`, false));
  if (new Set(result).size !== result.length) throw invalid(`${label} must not contain duplicates.`);
  return Object.freeze(result);
}

export function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw invalid(`${label} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

export function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${label} must be boolean.`);
  return value;
}

export function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : stringValue(value, label);
}

export function nullableBoolean(value: unknown, label: string): boolean | null {
  return value === null ? null : booleanValue(value, label);
}

function nullableInteger(value: unknown, label: string, minimum: number): number | null {
  return value === null ? null : integer(value, label, minimum);
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw invalid(`${label} is unsupported.`);
  return value as T;
}

function invalid(message: string): WindowsNativeError {
  return new WindowsNativeError("invalidPayload", message);
}
