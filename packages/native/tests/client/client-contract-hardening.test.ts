import assert from "node:assert/strict";
import test from "node:test";
import type { HostDescriptor, NativeWireMessage, WireRequest } from "../../src/contracts.js";
import { NativeClient, NativeClientError } from "../../src/client/index.js";
import { validateWireMessage } from "../../src/schema.js";
import { FakeNativeTransport, ManualRuntime, flush } from "./fake-transport.js";

const host = (): HostDescriptor => ({
  hostInstanceId: "host-current", platform: "windows", backend: "uia", maxMessageBytes: 1_048_576,
  methods: [
    { name: "host.handshake", intent: "observe", scopeKinds: ["bootstrap"] },
    { name: "session.launch", intent: "lifecycle", scopeKinds: ["host"] },
  ],
});

function response(request: WireRequest, result: unknown, operation: unknown = null): NativeWireMessage {
  return validateWireMessage({ protocol: "surfaceloom.native", version: "1.0", type: "response",
    id: request.id, ok: true, result, operation });
}

function handshakeTransport(): FakeNativeTransport {
  return new FakeNativeTransport((message, transport) => {
    if (message.type === "request" && message.call.name === "host.handshake") {
      transport.receive(response(message, host()));
    }
  });
}

test("transport close failure is observable and stable across repeated close calls", async () => {
  const closeCause = new Error("transport close receipt unavailable");
  class FailingCloseTransport extends FakeNativeTransport {
    closeCalls = 0;
    override async close(): Promise<void> {
      this.closeCalls += 1;
      throw closeCause;
    }
  }
  const automatic = handshakeTransport();
  const transport = new FailingCloseTransport(automatic.responder);
  const client = new NativeClient({ transport, runtime: new ManualRuntime() });
  await client.connect();
  let firstFailure: unknown;
  await assert.rejects(client.close(), (error: unknown) => {
    firstFailure = error;
    return error instanceof NativeClientError && error.code === "close_failed"
      && error.cause === closeCause;
  });
  await assert.rejects(client.close(), (error: unknown) => error === firstFailure);
  assert.equal(transport.closeCalls, 1);
  assert.equal(client.snapshot().state, "closed");
});

test("automatic close failure does not replace the connection failure and remains observable", async () => {
  const closeCause = new Error("close failed after malformed handshake");
  class MalformedHandshakeTransport extends FakeNativeTransport {
    override async close(): Promise<void> { throw closeCause; }
  }
  const transport = new MalformedHandshakeTransport((message, current) => {
    if (message.type === "request") current.receiveRaw("{\n");
  });
  const client = new NativeClient({ transport, runtime: new ManualRuntime() });
  await assert.rejects(client.connect(), (error: unknown) =>
    error instanceof NativeClientError && error.code === "protocol_violation");
  await assert.rejects(client.close(), (error: unknown) =>
    error instanceof NativeClientError && error.code === "close_failed"
      && error.cause === closeCause);
});

test("late launch response requires caller reconciliation and never becomes cleanup proof", async () => {
  const runtime = new ManualRuntime();
  let launchRequest: WireRequest | null = null;
  const late: Array<{
    readonly request: { readonly id: string; readonly operationId: string | null };
    readonly response: NativeWireMessage;
    readonly responsibility: string;
    readonly cleanupConfirmed: boolean;
  }> = [];
  const transport = new FakeNativeTransport((message, current) => {
    if (message.type !== "request") return;
    if (message.call.name === "host.handshake") current.receive(response(message, host()));
    else if (message.call.name === "session.launch") launchRequest = message;
  });
  const client = new NativeClient({ transport, runtime, onLateResponse: (event) => late.push(event) });
  await client.connect();
  const launching = client.launchSession({ payload: {}, timeoutMs: 10, operationId: "late-launch" });
  await flush();
  runtime.advance(10);
  await assert.rejects(launching, (error: unknown) => error instanceof NativeClientError
    && error.code === "deadline" && error.operationOutcome === "unknown");
  assert.notEqual(launchRequest, null);
  transport.receive(response(launchRequest as WireRequest, {
    hostInstanceId: "host-current", sessionId: "late-session", ownership: "owned", surface: "application",
    root: { hostInstanceId: "host-current", sessionId: "late-session", handleId: "late-root" },
  }, { operationId: "late-launch", outcome: "executed" }));
  assert.equal(client.snapshot().state, "ready");
  assert.equal(client.snapshot().trackedSessionCount, 0);
  assert.equal(late.length, 1);
  assert.equal(late[0]?.request.id, (launchRequest as WireRequest).id);
  assert.equal(late[0]?.request.operationId, "late-launch");
  assert.equal(late[0]?.responsibility, "callerReconciliation");
  assert.equal(late[0]?.cleanupConfirmed, false);
  assert.equal(late[0]?.response.type, "response");
  if (late[0]?.response.type === "response") assert.equal(late[0].response.operation?.outcome, "executed");
});

test("a duplicate timely response is not mislabeled as timeout reconciliation", async () => {
  let launchRequest: WireRequest | null = null;
  let lateCount = 0;
  const transport = new FakeNativeTransport((message, current) => {
    if (message.type !== "request") return;
    if (message.call.name === "host.handshake") current.receive(response(message, host()));
    else {
      launchRequest = message;
      current.receive(response(message, {
        hostInstanceId: "host-current", sessionId: "timely", ownership: "owned", surface: "application",
        root: { hostInstanceId: "host-current", sessionId: "timely", handleId: "root" },
      }, { operationId: message.call.operationId, outcome: "executed" }));
    }
  });
  const client = new NativeClient({ transport, runtime: new ManualRuntime(),
    onLateResponse: () => { lateCount += 1; } });
  await client.connect();
  await client.launchSession({ payload: {}, timeoutMs: 100, operationId: "timely-launch" });
  assert.notEqual(launchRequest, null);
  transport.receive(response(launchRequest as WireRequest, {
    hostInstanceId: "host-current", sessionId: "timely", ownership: "owned", surface: "application",
    root: { hostInstanceId: "host-current", sessionId: "timely", handleId: "root" },
  }, { operationId: "timely-launch", outcome: "executed" }));
  assert.equal(lateCount, 0);
  assert.equal(client.snapshot().state, "ready");
});
