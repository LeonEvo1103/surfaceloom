import type { JsonObject, JsonValue } from "../contracts.js";
import type { WindowsUiaLocator, WindowsWaitOptions } from "./contracts.js";

export function locatorPayload(locator: WindowsUiaLocator): JsonObject {
  return Object.freeze({ automationIds: locator.automationIds, names: locator.names,
    controlTypes: locator.controlTypes, classNames: locator.classNames,
    frameworkIds: locator.frameworkIds, nativeWindowHandle: locator.nativeWindowHandle,
    scope: locator.scope, matchIndex: locator.matchIndex }) as JsonObject;
}

export function waitPayload(wait: WindowsWaitOptions): JsonObject {
  return Object.freeze({ timeoutMs: wait.timeoutMs, pollIntervalMs: wait.pollIntervalMs });
}

export function jsonStringArray(values: readonly string[]): readonly JsonValue[] {
  return Object.freeze([...values]);
}

export function jsonEnvironment(values: Readonly<Record<string, string>>): JsonObject {
  return Object.freeze({ ...values });
}
