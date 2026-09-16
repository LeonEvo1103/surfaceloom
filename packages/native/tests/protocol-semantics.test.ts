import assert from "node:assert/strict";
import test from "node:test";
import {
  assertHandleScope, assertOwnershipAllows, disconnectedOperationOutcome, NativeProtocolError,
  validateCallAgainstHost, validateHostDescriptor, validateResponseForRequest, validateSessionDescriptor, validateWireMessage,
  type NativeSessionDescriptor, type WireRequest, type WireResponse,
} from "../src/index.js";

function request(intent: "observe" | "mutate" | "lifecycle" = "mutate"): WireRequest {
  return validateWireMessage({
    protocol: "surfaceloom.native", version: "1.0", type: "request", id: "request-1",
    deadline: { timeoutMs: 1000 }, call: {
      name: intent === "observe" ? "accessibility.snapshot" : "accessibility.perform",
      intent, ...(intent === "observe" ? {} : { operationId: "operation-1" }),
      scope: { kind: "session", hostInstanceId: "host-1", sessionId: "session-1" }, payload: {},
    },
  }) as WireRequest;
}

function response(overrides: Record<string, unknown> = {}): WireResponse {
  const input: Record<string, unknown> = {
    protocol: "surfaceloom.native", version: "1.0", type: "response", id: "request-1",
    ok: true, result: {}, operation: { operationId: "operation-1", outcome: "executed" }, ...overrides,
  };
  if (input.ok === false) delete input.result;
  return validateWireMessage(input) as WireResponse;
}

const owned = (): NativeSessionDescriptor => validateSessionDescriptor({
  hostInstanceId: "host-1", sessionId: "session-1", ownership: "owned", surface: "application",
  root: { hostInstanceId: "host-1", sessionId: "session-1", handleId: "root-1" },
});

test("side-effecting request and response require the same operation receipt", () => {
  assert.doesNotThrow(() => validateResponseForRequest(request(), response()));
  assert.throws(() => validateResponseForRequest(request(), response({ id: "request-2" })),
    (error: unknown) => error instanceof NativeProtocolError && error.code === "correlation_mismatch");
  assert.throws(() => validateResponseForRequest(request(), response({ operation: null })), /operation receipt/);
  assert.throws(() => validateResponseForRequest(request(), response({
    operation: { operationId: "operation-2", outcome: "executed" },
  })), /operation receipt/);
});

test("success proves executed and safe retry requires notExecuted", () => {
  assert.throws(() => validateResponseForRequest(request(), response({
    operation: { operationId: "operation-1", outcome: "unknown" },
  })), /must prove executed/);
  const unsafe = response({ ok: false,
    error: { code: "backend_lost", category: "backend", message: "Receipt unavailable.", retry: "safe" },
    operation: { operationId: "operation-1", outcome: "unknown" } });
  assert.throws(() => validateResponseForRequest(request(), unsafe), /safe retry/);
  const skipped = response({ ok: false,
    error: { code: "target_changed", category: "conflict", message: "Target changed.", retry: "safe" },
    operation: { operationId: "operation-1", outcome: "notExecuted" } });
  assert.doesNotThrow(() => validateResponseForRequest(request(), skipped));
});

test("observe calls forbid operation ids and operation receipts", () => {
  const observation = request("observe");
  const result = response({ operation: null });
  assert.doesNotThrow(() => validateResponseForRequest(observation, result));
  assert.throws(() => validateResponseForRequest(observation, response()), /must not claim/);
  assert.throws(() => validateWireMessage({ ...observation,
    call: { ...observation.call, operationId: "invalid" },
  }), /must not carry/);
});

test("disconnect classification never invents at-most-once evidence", () => {
  const action = request();
  assert.equal(disconnectedOperationOutcome(action, "beforeWrite"), "notExecuted");
  assert.equal(disconnectedOperationOutcome(action, "writing"), "unknown");
  assert.equal(disconnectedOperationOutcome(action, "written"), "unknown");
  assert.equal(disconnectedOperationOutcome(request("observe"), "written"), null);
});

test("owned sessions alone grant close and terminate authority", () => {
  const external = validateSessionDescriptor({ ...owned(), ownership: "borrowed" });
  for (const session of [owned(), external]) assert.doesNotThrow(() => assertOwnershipAllows(session, "release"));
  assert.doesNotThrow(() => assertOwnershipAllows(owned(), "close"));
  assert.doesNotThrow(() => assertOwnershipAllows(owned(), "terminate"));
  assert.throws(() => assertOwnershipAllows(external, "close"), /owned native session/);
  assert.throws(() => assertOwnershipAllows(external, "terminate"), /owned native session/);
  assert.throws(() => validateSessionDescriptor({ ...external, surface: "system", ownership: "owned" }),
    /System sessions must be borrowed/);
});

test("handles are scoped to both host instance and session", () => {
  const session = owned();
  assert.doesNotThrow(() => assertHandleScope(session, session.root));
  assert.throws(() => assertHandleScope(session, { ...session.root, sessionId: "session-2" }),
    (error: unknown) => error instanceof NativeProtocolError && error.code === "scope_mismatch");
  assert.throws(() => assertHandleScope(session, { ...session.root, hostInstanceId: "host-restarted" }),
    /does not belong/);
  assert.throws(() => validateSessionDescriptor({ ...session,
    root: { ...session.root, sessionId: "session-2" },
  }), /does not belong/);
});

test("host descriptors bound advertised methods and frame size", () => {
  const methods = [
    { name: "host.handshake", intent: "observe", scopeKinds: ["bootstrap"] },
    { name: "session.launch", intent: "lifecycle", scopeKinds: ["host"] },
    { name: "accessibility.perform", intent: "lifecycle", scopeKinds: ["session"] },
  ];
  const host = validateHostDescriptor({ hostInstanceId: "host-1", platform: "windows", backend: "uia",
    methods, maxMessageBytes: 1048576 });
  assert.deepEqual(host.methods, methods);
  assert.throws(() => validateHostDescriptor({ ...host, methods: [methods[0], methods[0]] }),
    /must be unique/);
  assert.throws(() => validateHostDescriptor({ ...host, methods: [methods[0], {
    name: "session.launch", intent: "observe", scopeKinds: ["session"],
  }] }), /session\.launch/);
  assert.throws(() => validateHostDescriptor({ ...host, methods: [methods[0], {
    name: "accessibility.snapshot", intent: "observe", scopeKinds: ["bootstrap"],
  }] }), /Only host\.handshake/);
  assert.throws(() => validateHostDescriptor({ ...host, maxMessageBytes: 1048577 }), /between/);
  assert.doesNotThrow(() => validateCallAgainstHost(request("lifecycle").call, host));
  assert.throws(() => validateCallAgainstHost(request("observe").call, host), /does not advertise/);
  assert.throws(() => validateCallAgainstHost({ ...request("lifecycle").call,
    scope: { kind: "session", hostInstanceId: "host-restarted", sessionId: "session-1" },
  }, host), /stale host instance/);
  const launch = { protocol: "surfaceloom.native", version: "1.0", type: "request", id: "launch-1",
    deadline: { timeoutMs: 1000 }, call: { name: "session.launch", intent: "observe",
      scope: { kind: "host", hostInstanceId: "host-1" }, payload: {} } };
  assert.throws(() => validateWireMessage(launch), /session\.launch/);
});

test("bootstrap scope is executable protocol bootstrap, not a general host bypass", () => {
  const handshake = validateWireMessage({
    protocol: "surfaceloom.native", version: "1.0", type: "request", id: "handshake-1",
    deadline: { timeoutMs: 1000 }, call: {
      name: "host.handshake", intent: "observe", scope: { kind: "bootstrap" }, payload: {},
    },
  });
  assert.equal(handshake.type, "request");
  assert.throws(() => validateWireMessage({ ...handshake,
    call: { ...handshake.call, name: "session.launch" },
  }), /Only host\.handshake/);
  assert.throws(() => validateWireMessage({ ...handshake,
    call: { ...handshake.call, scope: { kind: "host", hostInstanceId: "host-1" } },
  }), /Only host\.handshake/);
});
