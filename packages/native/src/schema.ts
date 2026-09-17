import {
  cancellationReasons, errorCategories, maxDeadlineMs, maxWireMessageBytes, nativeProtocolName,
  nativeProtocolVersion, operationIntents, operationOutcomes, retryDispositions,
  sessionOwnerships,
} from "./constants.js";
import type {
  HandleScope, HostDescriptor, HostScope, NativeCall, NativeHandle, NativeMethodDescriptor, NativeScope,
  NativeSessionDescriptor, NativeWireMessage, OperationReceipt, SessionScope, WireCancel,
  WireDeadline, WireError, WireFailure, WireRequest, WireResponse, WireSuccess,
} from "./contracts.js";
import { NativeProtocolError } from "./protocol-error.js";
import { arrayValues, choice, identifier, integer, invalid, jsonValue, record, required, text } from "./validation-primitives.js";

function header(input: Record<string, unknown>): void {
  const protocol = required(input, "protocol", "message");
  if (protocol !== nativeProtocolName) throw new NativeProtocolError("unsupported_protocol", "Unsupported native protocol.");
  const version = required(input, "version", "message");
  if (version !== nativeProtocolVersion) throw new NativeProtocolError("unsupported_version", "Unsupported native protocol version.");
  identifier(required(input, "id", "message"), "message.id");
}

function scope(value: unknown): NativeScope {
  const kindInput = record(value, "call.scope", ["kind", "hostInstanceId", "sessionId", "handleId"]);
  const kind = required(kindInput, "kind", "call.scope");
  if (kind === "bootstrap") {
    record(value, "call.scope", ["kind"]);
    return Object.freeze({ kind: "bootstrap" });
  }
  const hostInstanceId = identifier(required(kindInput, "hostInstanceId", "call.scope"), "call.scope.hostInstanceId");
  if (kind === "host") {
    record(value, "call.scope", ["kind", "hostInstanceId"]);
    return Object.freeze({ kind, hostInstanceId }) as HostScope;
  }
  const sessionId = identifier(required(kindInput, "sessionId", "call.scope"), "call.scope.sessionId");
  if (kind === "session") {
    record(value, "call.scope", ["kind", "hostInstanceId", "sessionId"]);
    return Object.freeze({ kind, hostInstanceId, sessionId }) as SessionScope;
  }
  if (kind === "handle") {
    record(value, "call.scope", ["kind", "hostInstanceId", "sessionId", "handleId"]);
    const handleId = identifier(required(kindInput, "handleId", "call.scope"), "call.scope.handleId");
    return Object.freeze({ kind, hostInstanceId, sessionId, handleId }) as HandleScope;
  }
  return invalid("call.scope.kind is not supported.");
}

function deadline(value: unknown): WireDeadline {
  const input = record(value, "deadline", ["timeoutMs"]);
  return Object.freeze({ timeoutMs: integer(required(input, "timeoutMs", "deadline"),
    "deadline.timeoutMs", 0, maxDeadlineMs) });
}

function call(value: unknown): NativeCall {
  const input = record(value, "call", ["name", "intent", "scope", "payload", "operationId"]);
  const name = methodName(required(input, "name", "call"), "call.name");
  const intent = choice(required(input, "intent", "call"), operationIntents, "call.intent");
  const operationId = Object.hasOwn(input, "operationId")
    ? identifier(input.operationId, "call.operationId") : undefined;
  if (intent === "observe" && operationId !== undefined) invalid("Observe calls must not carry operationId.");
  if (intent !== "observe" && operationId === undefined) invalid("Mutate and lifecycle calls require operationId.");
  const payload = jsonValue(required(input, "payload", "call"), "call.payload");
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) invalid("call.payload must be an object.");
  const checkedScope = scope(required(input, "scope", "call"));
  if ((checkedScope.kind === "bootstrap") !== (name === "host.handshake")) {
    invalid("Only host.handshake may use bootstrap scope, and it must use that scope.");
  }
  if (name === "host.handshake" && intent !== "observe") invalid("host.handshake must be an observe call.");
  if (name === "session.launch" && (intent !== "lifecycle" || checkedScope.kind !== "host")) {
    invalid("session.launch must be a host-scoped lifecycle call.");
  }
  return Object.freeze({ name, intent, scope: checkedScope, payload: payload as import("./contracts.js").JsonObject,
    ...(operationId === undefined ? {} : { operationId }) });
}

function receipt(value: unknown): OperationReceipt | null {
  if (value === null) return null;
  const input = record(value, "operation", ["operationId", "outcome"]);
  return Object.freeze({
    operationId: identifier(required(input, "operationId", "operation"), "operation.operationId"),
    outcome: choice(required(input, "outcome", "operation"), operationOutcomes, "operation.outcome"),
  });
}

function wireError(value: unknown): WireError {
  const input = record(value, "error", ["code", "category", "message", "retry", "details"]);
  const code = identifier(required(input, "code", "error"), "error.code");
  const category = choice(required(input, "category", "error"), errorCategories, "error.category");
  const message = text(required(input, "message", "error"), "error.message", 2_048);
  const retry = choice(required(input, "retry", "error"), retryDispositions, "error.retry");
  const detailsValue = Object.hasOwn(input, "details") ? jsonValue(input.details, "error.details") : undefined;
  if (detailsValue !== undefined && (detailsValue === null || typeof detailsValue !== "object" || Array.isArray(detailsValue))) {
    invalid("error.details must be an object.");
  }
  return Object.freeze({ code, category, message, retry,
    ...(detailsValue === undefined ? {} : { details: detailsValue }) }) as WireError;
}

function requestMessage(value: unknown): WireRequest {
  const input = record(value, "message", ["protocol", "version", "type", "id", "deadline", "call"]);
  header(input);
  return Object.freeze({ protocol: nativeProtocolName, version: nativeProtocolVersion, type: "request",
    id: identifier(input.id, "message.id"), deadline: deadline(required(input, "deadline", "message")),
    call: call(required(input, "call", "message")) });
}

function cancelMessage(value: unknown): WireCancel {
  const input = record(value, "message", ["protocol", "version", "type", "id", "requestId", "reason"]);
  header(input);
  const id = identifier(input.id, "message.id");
  const requestId = identifier(required(input, "requestId", "message"), "message.requestId");
  if (id === requestId) invalid("Cancellation message id must differ from requestId.");
  return Object.freeze({ protocol: nativeProtocolName, version: nativeProtocolVersion, type: "cancel", id,
    requestId, reason: choice(required(input, "reason", "message"), cancellationReasons, "message.reason") });
}

function responseMessage(value: unknown): WireResponse {
  const common = record(value, "message", ["protocol", "version", "type", "id", "ok", "result", "error", "operation"]);
  header(common);
  if (typeof required(common, "ok", "message") !== "boolean") invalid("message.ok must be boolean.");
  const operation = receipt(required(common, "operation", "message"));
  if (common.ok === true) {
    const input = record(value, "message", ["protocol", "version", "type", "id", "ok", "result", "operation"]);
    const result = jsonValue(required(input, "result", "message"), "message.result");
    return Object.freeze({ protocol: nativeProtocolName, version: nativeProtocolVersion, type: "response",
      id: identifier(input.id, "message.id"), ok: true, result, operation }) as WireSuccess;
  }
  const input = record(value, "message", ["protocol", "version", "type", "id", "ok", "error", "operation"]);
  return Object.freeze({ protocol: nativeProtocolName, version: nativeProtocolVersion, type: "response",
    id: identifier(input.id, "message.id"), ok: false,
    error: wireError(required(input, "error", "message")), operation }) as WireFailure;
}

export function validateWireMessage(value: unknown): NativeWireMessage {
  const input = record(value, "message", [
    "protocol", "version", "type", "id", "deadline", "call", "requestId", "reason",
    "ok", "result", "error", "operation",
  ]);
  const type = required(input, "type", "message");
  if (type === "request") return requestMessage(value);
  if (type === "cancel") return cancelMessage(value);
  if (type === "response") return responseMessage(value);
  return invalid("message.type is not supported.");
}

export function validateNativeHandle(value: unknown): NativeHandle {
  const input = record(value, "handle", ["hostInstanceId", "sessionId", "handleId"]);
  return Object.freeze({
    hostInstanceId: identifier(required(input, "hostInstanceId", "handle"), "handle.hostInstanceId"),
    sessionId: identifier(required(input, "sessionId", "handle"), "handle.sessionId"),
    handleId: identifier(required(input, "handleId", "handle"), "handle.handleId"),
  });
}

export function validateSessionDescriptor(value: unknown): NativeSessionDescriptor {
  const input = record(value, "session", ["hostInstanceId", "sessionId", "ownership", "surface", "root"]);
  const result = Object.freeze({
    hostInstanceId: identifier(required(input, "hostInstanceId", "session"), "session.hostInstanceId"),
    sessionId: identifier(required(input, "sessionId", "session"), "session.sessionId"),
    ownership: choice(required(input, "ownership", "session"), sessionOwnerships, "session.ownership"),
    surface: choice(required(input, "surface", "session"), ["application", "system"] as const, "session.surface"),
    root: validateNativeHandle(required(input, "root", "session")),
  });
  assertHandleScope(result, result.root);
  if (result.surface === "system" && result.ownership !== "borrowed") invalid("System sessions must be borrowed.");
  return result;
}

export function validateHostDescriptor(value: unknown): HostDescriptor {
  const input = record(value, "host", ["hostInstanceId", "platform", "backend", "methods", "maxMessageBytes"]);
  const methods = arrayValues(required(input, "methods", "host"), "host.methods");
  if (methods.length === 0) invalid("host.methods must be a non-empty array.");
  const checked = methods.map((method, index) => methodDescriptor(method, `host.methods[${index}]`));
  if (new Set(checked.map((method) => method.name)).size !== checked.length) invalid("host.methods must be unique.");
  const handshake = checked.find((method) => method.name === "host.handshake");
  if (handshake === undefined || handshake.intent !== "observe"
      || handshake.scopeKinds.length !== 1 || handshake.scopeKinds[0] !== "bootstrap") {
    invalid("host.methods must declare host.handshake as observe/bootstrap.");
  }
  for (const method of checked) {
    if (method.name !== "host.handshake" && method.scopeKinds.includes("bootstrap")) {
      invalid("Only host.handshake may advertise bootstrap scope.");
    }
    if (method.name === "session.launch"
        && (method.intent !== "lifecycle" || method.scopeKinds.length !== 1
          || method.scopeKinds[0] !== "host")) {
      invalid("session.launch must be advertised as lifecycle/host.");
    }
  }
  const boundary = integer(required(input, "maxMessageBytes", "host"), "host.maxMessageBytes", 1, maxWireMessageBytes);
  return Object.freeze({ hostInstanceId: identifier(required(input, "hostInstanceId", "host"), "host.hostInstanceId"),
    platform: identifier(required(input, "platform", "host"), "host.platform"),
    backend: identifier(required(input, "backend", "host"), "host.backend"),
    methods: Object.freeze(checked), maxMessageBytes: boundary });
}

/** Enforces the host-advertised intent/scope contract before dispatch. */
export function validateCallAgainstHost(call: NativeCall, host: HostDescriptor): void {
  const method = host.methods.find((candidate) => candidate.name === call.name);
  if (method === undefined) invalid(`Host does not advertise method '${call.name}'.`);
  if (method.intent !== call.intent || !method.scopeKinds.includes(call.scope.kind)) {
    invalid(`Call '${call.name}' does not match its advertised intent and scope.`);
  }
  if (call.scope.kind !== "bootstrap" && call.scope.hostInstanceId !== host.hostInstanceId) {
    invalid(`Call '${call.name}' targets a different or stale host instance.`);
  }
}

export function assertHandleScope(session: Pick<NativeSessionDescriptor, "hostInstanceId" | "sessionId">,
  handle: NativeHandle): void {
  if (session.hostInstanceId !== handle.hostInstanceId || session.sessionId !== handle.sessionId) {
    throw new NativeProtocolError("scope_mismatch", "Native handle does not belong to this host session.");
  }
}

function methodDescriptor(value: unknown, label: string): NativeMethodDescriptor {
  const input = record(value, label, ["name", "intent", "scopeKinds"]);
  const kinds = arrayValues(required(input, "scopeKinds", label), `${label}.scopeKinds`);
  if (kinds.length === 0) invalid(`${label}.scopeKinds must be a non-empty array.`);
  const checkedKinds = kinds.map((kind, index) => choice(kind,
    ["bootstrap", "host", "session", "handle"] as const, `${label}.scopeKinds[${index}]`));
  if (new Set(checkedKinds).size !== checkedKinds.length) invalid(`${label}.scopeKinds must be unique.`);
  return Object.freeze({
    name: methodName(required(input, "name", label), `${label}.name`),
    intent: choice(required(input, "intent", label), operationIntents, `${label}.intent`),
    scopeKinds: Object.freeze(checkedKinds),
  });
}

function methodName(value: unknown, label: string): string {
  const name = text(value, label);
  if (!/^[a-z][a-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)+$/u.test(name)) {
    invalid(`${label} must be namespaced.`);
  }
  return name;
}
