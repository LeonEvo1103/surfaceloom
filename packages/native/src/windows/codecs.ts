import { types } from "node:util";

import type { NativeCodecContext, NativeResultCodec } from "../client/index.js";
import type { JsonValue, NativeHandle, NativeSessionDescriptor } from "../contracts.js";
import { assertHandleScope, validateNativeHandle, validateSessionDescriptor } from "../schema.js";
import type {
  WindowsElement, WindowsElementSnapshot, WindowsHostCapabilities, WindowsUiaLocator,
} from "./contracts.js";
import { WindowsNativeError } from "./error.js";
import {
  booleanValue, exactRecord, integer, nullableBoolean, nullableString, stringArray, stringValue,
} from "./validation.js";

export const windowsSessionCodec: NativeResultCodec<NativeSessionDescriptor> = Object.freeze({
  decode: (value: JsonValue, context: NativeCodecContext) => context.trackSession(validateSessionDescriptor(value)),
});

export const windowsHostCapabilitiesCodec: NativeResultCodec<WindowsHostCapabilities> = Object.freeze({
  decode(value: JsonValue): WindowsHostCapabilities {
    const input = exactRecord(value, "capabilities", ["protocolVersion", "platform", "backend", "methods",
      "locatorFields", "controlTypes", "actionRequirements", "features"]);
    if (input.protocolVersion !== "1.0" || input.platform !== "windows"
        || input.backend !== "windows-ui-automation") {
      throw new WindowsNativeError("invalidHandshake", "Windows capability identity does not match v1 UIA.");
    }
    const methods = stringArray(input.methods, "capabilities.methods");
    stringArray(input.locatorFields, "capabilities.locatorFields");
    stringArray(input.controlTypes, "capabilities.controlTypes");
    dynamicRecord(input.actionRequirements, "capabilities.actionRequirements", (item, label) =>
      stringValue(item, label));
    const features = dynamicRecord(input.features, "capabilities.features", featureSupport);
    return Object.freeze({ protocolVersion: "1.0", platform: "windows",
      backend: "windows-ui-automation", methods, features: Object.freeze(features) });
  },
});

export function windowsElementCodec(session: Pick<NativeSessionDescriptor, "hostInstanceId" | "sessionId">,
  locator: WindowsUiaLocator, rootHandleId: string): NativeResultCodec<WindowsElement> {
  return Object.freeze({
    decode(value: JsonValue, context: NativeCodecContext): WindowsElement {
      const { handle, snapshot } = decodeElementTuple(value, context.trackHandle, session);
      return Object.freeze({ handle, snapshot, locator, rootHandleId });
    },
  });
}

export interface WindowsElementTuple {
  readonly handle: NativeHandle;
  readonly snapshot: WindowsElementSnapshot;
}

export function windowsElementTupleCodec(
  session: Pick<NativeSessionDescriptor, "hostInstanceId" | "sessionId">,
  expectedHandle?: NativeHandle,
): NativeResultCodec<WindowsElementTuple> {
  return Object.freeze({ decode: (value: JsonValue, context: NativeCodecContext) => {
    const result = decodeElementTuple(value, context.trackHandle, session);
    if (expectedHandle !== undefined && (result.handle.hostInstanceId !== expectedHandle.hostInstanceId
        || result.handle.sessionId !== expectedHandle.sessionId
        || result.handle.handleId !== expectedHandle.handleId)) {
      throw new WindowsNativeError("invalidResult", "Element result does not match the requested handle.");
    }
    return result;
  } });
}

export function windowsEndCodec(expected: Readonly<{ sessionId: string;
  requestedAction: "close" | "terminate"; processId: number | null }>): NativeResultCodec<Readonly<{
  sessionId: string; processId: number; requestedAction: string; exited: true; wasAlreadyExited: boolean;
}>> {
  return Object.freeze({ decode(value: JsonValue) {
    const input = exactRecord(value, "processEnd", ["sessionId", "processId", "requestedAction",
      "exited", "wasAlreadyExited"]);
    const sessionId = stringValue(input.sessionId, "processEnd.sessionId", false);
    const processId = integer(input.processId, "processEnd.processId", 1);
    const requestedAction = stringValue(input.requestedAction, "processEnd.requestedAction", false);
    if (sessionId !== expected.sessionId || input.exited !== true
        || requestedAction !== expected.requestedAction
        || (expected.processId !== null && processId !== expected.processId)) {
      throw new WindowsNativeError("invalidResult", "Process end proof does not match the active session.");
    }
    return Object.freeze({ sessionId, processId,
      requestedAction, exited: true as const,
      wasAlreadyExited: booleanValue(input.wasAlreadyExited, "processEnd.wasAlreadyExited") });
  } });
}

export function windowsReleaseCodec(expectedSessionId: string): NativeResultCodec<Readonly<{
  released: true; sessionId: string;
}>> {
  return Object.freeze({ decode(value: JsonValue) {
    const input = exactRecord(value, "release", ["released", "sessionId"]);
    if (input.released !== true || input.sessionId !== expectedSessionId) {
      throw new WindowsNativeError("invalidResult", "Session release proof does not match the active session.");
    }
    return Object.freeze({ released: true as const, sessionId: expectedSessionId });
  } });
}

export const emptyObjectCodec: NativeResultCodec<Readonly<Record<string, never>>> = Object.freeze({
  decode(value: JsonValue) {
    exactRecord(value, "result", []);
    return Object.freeze({});
  },
});

function decodeSnapshot(value: unknown): WindowsElementSnapshot {
  const input = exactRecord(value, "snapshot", ["elementId", "name", "automationId", "controlType",
    "className", "frameworkId", "processId", "nativeWindowHandle", "isEnabled", "isOffscreen", "value",
    "hasKeyboardFocus", "isSelected", "toggleState", "expandCollapseState", "ariaRole", "ariaProperties",
    "isReadOnly", "supportedActions"]);
  return Object.freeze({
    elementId: stringValue(input.elementId, "snapshot.elementId", false),
    name: stringValue(input.name, "snapshot.name"),
    automationId: stringValue(input.automationId, "snapshot.automationId"),
    controlType: stringValue(input.controlType, "snapshot.controlType", false),
    className: stringValue(input.className, "snapshot.className"),
    frameworkId: stringValue(input.frameworkId, "snapshot.frameworkId"),
    processId: integer(input.processId, "snapshot.processId", 0),
    nativeWindowHandle: integer(input.nativeWindowHandle, "snapshot.nativeWindowHandle", 0),
    isEnabled: booleanValue(input.isEnabled, "snapshot.isEnabled"),
    isOffscreen: booleanValue(input.isOffscreen, "snapshot.isOffscreen"),
    value: nullableString(input.value, "snapshot.value"),
    hasKeyboardFocus: booleanValue(input.hasKeyboardFocus, "snapshot.hasKeyboardFocus"),
    isSelected: nullableBoolean(input.isSelected, "snapshot.isSelected"),
    toggleState: nullableString(input.toggleState, "snapshot.toggleState"),
    expandCollapseState: nullableString(input.expandCollapseState, "snapshot.expandCollapseState"),
    ariaRole: nullableString(input.ariaRole, "snapshot.ariaRole"),
    ariaProperties: nullableString(input.ariaProperties, "snapshot.ariaProperties"),
    isReadOnly: nullableBoolean(input.isReadOnly, "snapshot.isReadOnly"),
    supportedActions: stringArray(input.supportedActions, "snapshot.supportedActions"),
  });
}

function decodeElementTuple(value: unknown, track: (handle: NativeHandle) => NativeHandle,
  session: Pick<NativeSessionDescriptor, "hostInstanceId" | "sessionId">): WindowsElementTuple {
  const input = exactRecord(value, "element", ["handle", "snapshot"]);
  const handle = validateNativeHandle(input.handle);
  assertHandleScope(session, handle);
  const snapshot = decodeSnapshot(input.snapshot);
  if (handle.handleId !== snapshot.elementId) {
    throw new WindowsNativeError("invalidResult", "Element handle and snapshot identities differ.");
  }
  track(handle);
  return Object.freeze({ handle, snapshot });
}

function featureSupport(value: unknown, label: string): "supported" | "conditional" | "unsupported" {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    throw new WindowsNativeError("invalidResult", `${label} must be plain data.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(["support", "summary", "conditions"]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new WindowsNativeError("invalidResult", `${label} contains unknown fields.`);
  }
  const support = data(descriptors, "support", label);
  if (support !== "supported" && support !== "conditional" && support !== "unsupported") {
    throw new WindowsNativeError("invalidResult", `${label}.support is unsupported.`);
  }
  stringValue(data(descriptors, "summary", label), `${label}.summary`);
  if (descriptors.conditions !== undefined) stringArray(data(descriptors, "conditions", label), `${label}.conditions`);
  return support;
}

function dynamicRecord<T>(value: unknown, label: string,
  decode: (item: unknown, itemLabel: string) => T): Record<string, T> {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    throw new WindowsNativeError("invalidResult", `${label} must be plain data.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WindowsNativeError("invalidResult", `${label} must be plain data.`);
  }
  const result: Record<string, T> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new WindowsNativeError("invalidResult", `${label}.${key} must be data.`);
    }
    result[key] = decode(descriptor.value, `${label}.${key}`);
  }
  return result;
}

function data(descriptors: Record<string, PropertyDescriptor>, key: string, label: string): unknown {
  const descriptor = descriptors[key];
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new WindowsNativeError("invalidResult", `${label}.${key} is required.`);
  }
  return descriptor.value;
}
