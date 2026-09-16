import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import type { HostDescriptor, NativeWireMessage, WireRequest } from "../../src/contracts.js";
import {
  NativeClient, NativeClientError, NativeRemoteError, NativeTransportWriteError, jsonResultCodec,
} from "../../src/client/index.js";
import { parseWireLine } from "../../src/framing.js";
import { validateWireMessage } from "../../src/schema.js";
import { FakeNativeTransport, ManualRuntime, flush } from "./fake-transport.js";

const descriptor: HostDescriptor = { hostInstanceId: "host-1", platform: "windows", backend: "uia",
  maxMessageBytes: 1_048_576, methods: [
    { name: "host.handshake", intent: "observe", scopeKinds: ["bootstrap"] },
    { name: "session.launch", intent: "lifecycle", scopeKinds: ["host"] },
    { name: "desktop.perform", intent: "mutate", scopeKinds: ["host"] },
    { name: "desktop.observe", intent: "observe", scopeKinds: ["host"] },
  ] };

function success(request: WireRequest, result: unknown, operation: unknown = null): NativeWireMessage {
  return validateWireMessage({ protocol: "surfaceloom.native", version: "1.0", type: "response",
    id: request.id, ok: true, result, operation });
}

function handshakeThen(onRequest: (request: WireRequest, transport: FakeNativeTransport) => void): FakeNativeTransport {
  return new FakeNativeTransport((message, transport) => {
    if (message.type !== "request") return;
    if (message.call.name === "host.handshake") transport.receive(success(message, descriptor));
    else onRequest(message, transport);
  });
}

test("wrong protocol version during handshake closes and fails the connection", async () => {
  const transport = new FakeNativeTransport((message, current) => {
    if (message.type !== "request") return;
    current.receiveRaw(`${JSON.stringify({ protocol: "surfaceloom.native", version: "9.0", type: "response",
      id: message.id, ok: true, result: descriptor, operation: null })}\n`);
  });
  const client = new NativeClient({ transport });
  await assert.rejects(client.connect(), (error: unknown) =>
    error instanceof NativeClientError && error.code === "protocol_violation");
  assert.equal(client.snapshot().state, "disconnected");
  assert.equal(transport.closed, true);
});

test("response id correlation violation disconnects rather than accepting another request result", async () => {
  const transport = handshakeThen((request, current) => current.receive(validateWireMessage({
    protocol: "surfaceloom.native", version: "1.0", type: "response", id: `${request.id}-wrong`,
    ok: true, result: {}, operation: null,
  })));
  const client = new NativeClient({ transport });
  await client.connect();
  await assert.rejects(client.invoke({ name: "desktop.observe", intent: "observe",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 100,
    codec: jsonResultCodec }), (error: unknown) =>
    error instanceof NativeClientError && error.code === "protocol_violation");
  assert.equal(client.snapshot().state, "disconnected");
});

test("deadline uses the one relative budget, sends best-effort cancel, and never replays", async () => {
  const runtime = new ManualRuntime();
  const transport = handshakeThen(() => {});
  const client = new NativeClient({ transport, runtime });
  const connecting = client.connect(500);
  await connecting;
  runtime.nowValue = 20;
  const pending = client.invoke({ name: "desktop.perform", intent: "mutate",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 40,
    operationId: "operation-stable", codec: jsonResultCodec });
  await flush();
  const request = parseWireLine(transport.writes.at(-1) ?? "") as WireRequest;
  assert.equal(request.deadline.timeoutMs, 39);
  runtime.advance(40);
  await assert.rejects(pending, (error: unknown) => error instanceof NativeClientError
    && error.code === "deadline" && error.operationOutcome === "unknown");
  await flush();
  const messages = transport.writes.map((frame) => parseWireLine(frame));
  assert.equal(messages.filter((message) => message.type === "request"
    && message.call.name === "desktop.perform").length, 1);
  const cancel = messages.find((message) => message.type === "cancel");
  assert.equal(cancel?.type, "cancel");
  if (cancel?.type === "cancel") assert.equal(cancel.requestId, request.id);
});

test("partial and full-write disconnects conservatively report unknown and do not replay", async () => {
  for (const mode of ["partial", "disconnect"] as const) {
    const transport = handshakeThen(() => {});
    const client = new NativeClient({ transport });
    await client.connect();
    if (mode === "partial") transport.writeBehavior = async () => {
      throw new NativeTransportWriteError("writing", "partial");
    };
    const pending = client.invoke({ name: "desktop.perform", intent: "mutate",
      scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 5_000,
      codec: jsonResultCodec });
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof NativeClientError
      && error.operationOutcome === "unknown"
      && (error.code === "write_failed" || error.code === "disconnected"));
    await flush();
    if (mode === "disconnect") transport.disconnect(new Error("pipe closed"));
    await rejected;
    assert.equal(transport.writes.filter((frame) => {
      const message = parseWireLine(frame);
      return message.type === "request" && message.call.name === "desktop.perform";
    }).length, 1);
  }
});

test("before-write failure is notExecuted but still is not automatically retried", async () => {
  const transport = handshakeThen(() => {});
  const client = new NativeClient({ transport });
  await client.connect();
  transport.writeBehavior = async () => { throw new NativeTransportWriteError("beforeWrite", "closed"); };
  await assert.rejects(client.invoke({ name: "desktop.perform", intent: "mutate",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 100,
    codec: jsonResultCodec }), (error: unknown) => error instanceof NativeClientError
      && error.operationOutcome === "notExecuted" && error.writePhase === "beforeWrite");
  assert.equal(transport.writes.length, 2);
});

test("remote unknown receipt is surfaced and never interpreted as retry permission", async () => {
  const transport = handshakeThen((request, current) => current.receive(validateWireMessage({
    protocol: "surfaceloom.native", version: "1.0", type: "response", id: request.id, ok: false,
    error: { code: "backend_lost", category: "backend", message: "receipt unavailable", retry: "never" },
    operation: { operationId: request.call.operationId, outcome: "unknown" },
  })));
  const client = new NativeClient({ transport });
  await client.connect();
  await assert.rejects(client.invoke({ name: "desktop.perform", intent: "mutate",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 100,
    codec: jsonResultCodec }), (error: unknown) => error instanceof NativeRemoteError
      && error.operation?.outcome === "unknown" && error.wireError.retry === "never");
  assert.equal(transport.writes.length, 2);
});

test("negotiated frame boundary rejects oversized payload before write", async () => {
  const small = { ...descriptor, maxMessageBytes: 300 };
  const transport = new FakeNativeTransport((message, current) => {
    if (message.type === "request" && message.call.name === "host.handshake") {
      current.receive(success(message, small));
    }
  });
  const client = new NativeClient({ transport });
  await client.connect();
  const writes = transport.writes.length;
  await assert.rejects(client.invoke({ name: "desktop.observe", intent: "observe",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: { content: "x".repeat(500) },
    timeoutMs: 100, codec: jsonResultCodec }), /negotiated host frame boundary/);
  assert.equal(transport.writes.length, writes);
});

test("short successful write receipt is treated as partial write", async () => {
  const transport = handshakeThen(() => {});
  const client = new NativeClient({ transport });
  await client.connect();
  transport.writeBehavior = async (frame) => ({ bytesWritten: Buffer.byteLength(frame, "utf8") - 1 });
  await assert.rejects(client.invoke({ name: "desktop.perform", intent: "mutate",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 100,
    codec: jsonResultCodec }), (error: unknown) => error instanceof NativeClientError
      && error.operationOutcome === "unknown" && error.writePhase === "writing");
});

test("correlation failure after write preserves conservative unknown outcome", async () => {
  const transport = handshakeThen((request, current) => current.receive(validateWireMessage({
    protocol: "surfaceloom.native", version: "1.0", type: "response", id: request.id, ok: true,
    result: {}, operation: { operationId: "wrong-operation", outcome: "executed" },
  })));
  const client = new NativeClient({ transport });
  await client.connect();
  await assert.rejects(client.invoke({ name: "desktop.perform", intent: "mutate",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 100,
    operationId: "expected-operation", codec: jsonResultCodec }), (error: unknown) =>
      error instanceof NativeClientError && error.code === "protocol_violation"
      && error.operationOutcome === "unknown" && error.requestId !== null);
});

test("codec failure preserves a trusted executed receipt", async () => {
  const transport = handshakeThen((request, current) => current.receive(success(request, { malformed: true }, {
    operationId: request.call.operationId, outcome: "executed",
  })));
  const client = new NativeClient({ transport });
  await client.connect();
  await assert.rejects(client.invoke({ name: "desktop.perform", intent: "mutate",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 100,
    codec: { decode: () => { throw new Error("platform shape mismatch"); } } }), (error: unknown) =>
      error instanceof NativeClientError && error.code === "decode_failed"
      && error.operationOutcome === "executed" && error.requestId !== null);
  assert.equal(client.snapshot().state, "ready");
});

test("codec tracking is transactional when decoding later fails", async () => {
  const transport = handshakeThen((request, current) => current.receive(success(request, {})));
  const client = new NativeClient({ transport });
  await client.connect();
  await assert.rejects(client.invoke({ name: "desktop.observe", intent: "observe",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 100,
    codec: { decode: (_value, context) => {
      context.trackSession({ hostInstanceId: "host-1", sessionId: "never-commit", ownership: "borrowed",
        surface: "application", root: { hostInstanceId: "host-1", sessionId: "never-commit", handleId: "root" } });
      context.trackHandle({ hostInstanceId: "host-1", sessionId: "never-commit", handleId: "child" });
      throw new Error("decode failed after staging");
    } } }), (error: unknown) => error instanceof NativeClientError && error.code === "decode_failed");
  assert.equal(client.snapshot().trackedSessionCount, 0);
  assert.equal(client.snapshot().trackedHandleCount, 0);
});

test("reused request ids fail closed instead of overwriting a pending request", async () => {
  const ids = ["handshake-request", "reused-request", "reused-request"];
  const transport = handshakeThen(() => {});
  const client = new NativeClient({ transport, idFactory: () => ids.shift() ?? "unexpected" });
  await client.connect();
  const first = client.invoke({ name: "desktop.observe", intent: "observe",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 5_000,
    codec: jsonResultCodec });
  const firstRejected = assert.rejects(first, (error: unknown) =>
    error instanceof NativeClientError && error.code === "disconnected");
  await assert.rejects(client.invoke({ name: "desktop.observe", intent: "observe",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 5_000,
    codec: jsonResultCodec }), (error: unknown) =>
    error instanceof NativeClientError && error.code === "protocol_violation");
  assert.equal(client.snapshot().activeRequestCount, 1);
  transport.disconnect();
  await firstRejected;
});

test("request, operation, and cancel ids share a no-reuse allocation guard", async () => {
  const ids = ["handshake-request", "same-id", "same-id"];
  const transport = handshakeThen(() => {});
  const client = new NativeClient({ transport, idFactory: () => ids.shift() ?? "unexpected" });
  await client.connect();
  await assert.rejects(client.invoke({ name: "desktop.perform", intent: "mutate",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 100,
    codec: jsonResultCodec }), (error: unknown) =>
    error instanceof NativeClientError && error.code === "protocol_violation");
  assert.equal(transport.writes.length, 1);
});

test("oversized inbound frame violates the negotiated boundary and keeps side effect unknown", async () => {
  const small = { ...descriptor, maxMessageBytes: 300 };
  const transport = new FakeNativeTransport((message, current) => {
    if (message.type !== "request") return;
    if (message.call.name === "host.handshake") current.receive(success(message, small));
    else current.receive(validateWireMessage({ protocol: "surfaceloom.native", version: "1.0",
      type: "response", id: message.id, ok: true, result: { content: "x".repeat(500) },
      operation: { operationId: message.call.operationId, outcome: "executed" } }));
  });
  const client = new NativeClient({ transport });
  await client.connect();
  await assert.rejects(client.invoke({ name: "desktop.perform", intent: "mutate",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 100,
    codec: jsonResultCodec }), (error: unknown) => error instanceof NativeClientError
      && error.code === "protocol_violation" && error.operationOutcome === "unknown");
  assert.equal(client.snapshot().state, "disconnected");
});

test("stripped inbound delimiter is still counted against negotiated frame bytes", async () => {
  const limit = 400;
  const small = { ...descriptor, maxMessageBytes: limit };
  const transport = new FakeNativeTransport((message, current) => {
    if (message.type !== "request") return;
    if (message.call.name === "host.handshake") { current.receive(success(message, small)); return; }
    const base = JSON.stringify({ protocol: "surfaceloom.native", version: "1.0", type: "response",
      id: message.id, ok: true, result: { content: "" }, operation: null });
    const markerBytes = Buffer.byteLength(base, "utf8");
    const raw = JSON.stringify({ protocol: "surfaceloom.native", version: "1.0", type: "response",
      id: message.id, ok: true, result: { content: "x".repeat(limit - markerBytes) }, operation: null });
    assert.equal(Buffer.byteLength(raw, "utf8"), limit);
    current.receiveRaw(raw);
  });
  const client = new NativeClient({ transport });
  await client.connect();
  await assert.rejects(client.invoke({ name: "desktop.observe", intent: "observe",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 100,
    codec: jsonResultCodec }), (error: unknown) => error instanceof NativeClientError
      && error.code === "protocol_violation");
});

test("local preprocessing time is deducted from the wire deadline", async () => {
  const runtime = new ManualRuntime();
  let chargeNextRequest = false;
  let sequence = 0;
  const transport = handshakeThen((request, current) => {
    assert.equal(request.deadline.timeoutMs, 32);
    current.receive(success(request, {}));
  });
  const client = new NativeClient({ transport, runtime, idFactory: (kind) => {
    if (chargeNextRequest && kind === "request") runtime.nowValue += 7;
    return `${kind}-${++sequence}`;
  } });
  await client.connect();
  chargeNextRequest = true;
  await client.invoke({ name: "desktop.observe", intent: "observe",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 40,
    codec: jsonResultCodec });
});

test("more than 1024 cancelled request ids remain valid late-response tombstones", async () => {
  const runtime = new ManualRuntime();
  let firstRequest: WireRequest | null = null;
  const transport = handshakeThen((request) => { firstRequest ??= request; });
  const client = new NativeClient({ transport, runtime });
  await client.connect();
  for (let index = 0; index < 1_025; index += 1) {
    const pending = client.invoke({ name: "desktop.observe", intent: "observe",
      scope: { kind: "host", hostInstanceId: "host-1" }, payload: { index }, timeoutMs: 2,
      codec: jsonResultCodec });
    const rejected = assert.rejects(pending, (error: unknown) =>
      error instanceof NativeClientError && error.code === "deadline");
    runtime.advance(2);
    await rejected;
  }
  assert.notEqual(firstRequest, null);
  transport.receive(success(firstRequest as WireRequest, { terminal: "late" }));
  assert.equal(client.snapshot().state, "ready");
  assert.equal(client.snapshot().activeRequestCount, 0);
});

test("synchronous beforeWrite throw clears pending state and deadline listener", async () => {
  const runtime = new ManualRuntime();
  const transport = handshakeThen(() => {});
  const client = new NativeClient({ transport, runtime });
  await client.connect();
  transport.writeBehavior = () => { throw new NativeTransportWriteError("beforeWrite", "sync closed"); };
  await assert.rejects(client.invoke({ name: "desktop.perform", intent: "mutate",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 50,
    codec: jsonResultCodec }), (error: unknown) => error instanceof NativeClientError
      && error.code === "write_failed" && error.operationOutcome === "notExecuted");
  assert.equal(client.snapshot().activeRequestCount, 0);
  const writesAfterFailure = transport.writes.length;
  runtime.advance(50);
  await flush();
  assert.equal(transport.writes.length, writesAfterFailure);
});

test("wire deadline plus write-start elapsed never exceeds the caller budget", async () => {
  let charge = false;
  let readIndex = 0;
  const chargedTimes = [0, 3, 8, 8, 8, 8, 8, 8];
  let timerId = 0;
  const runtime = {
    now: () => charge ? (chargedTimes[Math.min(readIndex++, chargedTimes.length - 1)] ?? 8) : 0,
    setTimer: () => ++timerId,
    clearTimer: () => {},
  };
  let writeStartElapsed = -1;
  let wireTimeout = -1;
  const transport = handshakeThen((request, current) => {
    writeStartElapsed = chargedTimes[Math.min(readIndex, chargedTimes.length - 1)] ?? 8;
    wireTimeout = request.deadline.timeoutMs;
    current.receive(success(request, {}));
  });
  const client = new NativeClient({ transport, runtime });
  await client.connect();
  charge = true;
  readIndex = 0;
  await client.invoke({ name: "desktop.observe", intent: "observe",
    scope: { kind: "host", hostInstanceId: "host-1" }, payload: {}, timeoutMs: 40,
    codec: jsonResultCodec });
  assert.equal(wireTimeout, 26);
  assert.equal(writeStartElapsed, 8);
  assert.ok(wireTimeout + writeStartElapsed <= 40);
});

test("large legal payload is serialized a bounded number of times and reaches transport", async () => {
  let dispatchedBytes = 0;
  const transport = handshakeThen((request, current) => {
    dispatchedBytes = Buffer.byteLength(JSON.stringify(request.call.payload), "utf8");
    current.receive(success(request, {}));
  });
  const client = new NativeClient({ transport });
  await client.connect();
  await client.invoke({ name: "desktop.observe", intent: "observe",
    scope: { kind: "host", hostInstanceId: "host-1" },
    payload: { content: "x".repeat(800_000) }, timeoutMs: 100, codec: jsonResultCodec });
  assert.ok(dispatchedBytes >= 800_000);
  assert.equal(transport.writes.filter((line) => {
    const message = parseWireLine(line);
    return message.type === "request" && message.call.name === "desktop.observe";
  }).length, 1);
});
