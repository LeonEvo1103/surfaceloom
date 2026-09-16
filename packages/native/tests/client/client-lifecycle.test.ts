import assert from "node:assert/strict";
import test from "node:test";
import type { HostDescriptor, NativeWireMessage, WireRequest } from "../../src/contracts.js";
import type { NativeTransportHandlers } from "../../src/client/index.js";
import { NativeClient, NativeClientError, jsonResultCodec } from "../../src/client/index.js";
import { validateWireMessage } from "../../src/schema.js";
import { FakeNativeTransport, ManualRuntime, flush } from "./fake-transport.js";

const host = (maximum = 1_048_576): HostDescriptor => ({
  hostInstanceId: "host-current", platform: "windows", backend: "uia", maxMessageBytes: maximum,
  methods: [
    { name: "host.handshake", intent: "observe", scopeKinds: ["bootstrap"] },
    { name: "session.launch", intent: "lifecycle", scopeKinds: ["host"] },
    { name: "accessibility.observe", intent: "observe", scopeKinds: ["session", "handle"] },
    { name: "accessibility.perform", intent: "mutate", scopeKinds: ["handle"] },
  ],
});

function response(request: WireRequest, result: unknown, operation: unknown = null): NativeWireMessage {
  return validateWireMessage({ protocol: "surfaceloom.native", version: "1.0", type: "response",
    id: request.id, ok: true, result, operation });
}

function autoTransport(descriptor = host()): FakeNativeTransport {
  return new FakeNativeTransport((message, transport) => {
    if (message.type !== "request") return;
    if (message.call.name === "host.handshake") transport.receive(response(message, descriptor));
    else if (message.call.name === "session.launch") transport.receive(response(message, {
      hostInstanceId: descriptor.hostInstanceId, sessionId: "session-1", ownership: "owned", surface: "application",
      root: { hostInstanceId: descriptor.hostInstanceId, sessionId: "session-1", handleId: "root-1" },
    }, { operationId: message.call.operationId, outcome: "executed" }));
    else transport.receive(response(message, { role: "button" }, message.call.intent === "observe" ? null
      : { operationId: message.call.operationId, outcome: "executed" }));
  });
}

test("connect negotiates methods and launch tracks session and root handle", async () => {
  const transport = autoTransport();
  const client = new NativeClient({ transport });
  const descriptor = await client.connect();
  assert.equal(descriptor.hostInstanceId, "host-current");
  const launched = await client.launchSession({ payload: { executable: "fixture" }, timeoutMs: 1_000 });
  assert.equal(launched.value.sessionId, "session-1");
  assert.equal(launched.operation?.outcome, "executed");
  assert.deepEqual(client.snapshot(), { state: "ready", host: descriptor, activeRequestCount: 0,
    trackedSessionCount: 1, trackedHandleCount: 1 });

  const observed = await client.invoke({ name: "accessibility.observe", intent: "observe",
    scope: { kind: "handle", hostInstanceId: "host-current", sessionId: "session-1", handleId: "root-1" },
    payload: {}, timeoutMs: 100, codec: jsonResultCodec });
  assert.deepEqual(observed.value, { role: "button" });
  assert.equal(observed.operation, null);
  await client.close();
  assert.equal(transport.closed, true);
});

test("method intent/scope negotiation fails before a request is written", async () => {
  const transport = autoTransport();
  const client = new NativeClient({ transport });
  await client.connect();
  const writeCount = transport.writes.length;
  await assert.rejects(client.invoke({ name: "accessibility.observe", intent: "mutate",
    scope: { kind: "host", hostInstanceId: "host-current" }, payload: {}, timeoutMs: 100,
    codec: jsonResultCodec }), /advertised intent and scope/);
  assert.equal(transport.writes.length, writeCount);
});

test("stale host, session, and handle scopes fail closed before transport dispatch", async () => {
  const transport = autoTransport();
  const client = new NativeClient({ transport });
  await client.connect();
  await client.launchSession({ payload: {}, timeoutMs: 100 });
  const writeCount = transport.writes.length;
  const invoke = (scope: Parameters<typeof client.invoke>[0]["scope"]) => client.invoke({
    name: "accessibility.observe", intent: "observe", scope, payload: {}, timeoutMs: 100,
    codec: jsonResultCodec,
  });
  for (const scope of [
    { kind: "session", hostInstanceId: "host-old", sessionId: "session-1" } as const,
    { kind: "session", hostInstanceId: "host-current", sessionId: "session-old" } as const,
    { kind: "handle", hostInstanceId: "host-current", sessionId: "session-1", handleId: "unknown" } as const,
  ]) {
    await assert.rejects(invoke(scope), (error: unknown) =>
      error instanceof NativeClientError && error.code === "stale_scope");
  }
  assert.equal(transport.writes.length, writeCount);
});

test("platform codecs can explicitly enroll returned handles without adding locator semantics", async () => {
  const transport = autoTransport();
  const client = new NativeClient({ transport });
  await client.connect();
  await client.launchSession({ payload: {}, timeoutMs: 100 });
  const enrolled = await client.invoke({ name: "accessibility.observe", intent: "observe",
    scope: { kind: "session", hostInstanceId: "host-current", sessionId: "session-1" }, payload: {}, timeoutMs: 100,
    codec: { decode: (_value, context) => context.trackHandle({ hostInstanceId: "host-current",
      sessionId: "session-1", handleId: "child-1" }) } });
  assert.equal(enrolled.value.handleId, "child-1");
  assert.equal(client.snapshot().trackedHandleCount, 2);
});

test("released session ids cannot be revived inside the same host instance", async () => {
  const transport = autoTransport();
  const client = new NativeClient({ transport });
  await client.connect();
  const session = (await client.launchSession({ payload: {}, timeoutMs: 100 })).value;
  client.forgetSession(session.sessionId);
  assert.throws(() => client.trackSession(session), (error: unknown) =>
    error instanceof NativeClientError && error.code === "stale_scope");
});

class DeferredOpenTransport extends FakeNativeTransport {
  #resolveOpen: (() => void) | null = null;
  override open(handlers: NativeTransportHandlers): Promise<void> {
    this.handlers = handlers;
    return new Promise((resolve) => { this.#resolveOpen = resolve; });
  }
  releaseOpen(): void { this.#resolveOpen?.(); }
}

test("disconnect during open settles connect and late open cannot start handshake", async () => {
  const transport = new DeferredOpenTransport();
  const client = new NativeClient({ transport });
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, (error: unknown) =>
    error instanceof NativeClientError && error.code === "disconnected");
  transport.disconnect(new Error("host exited while opening"));
  await rejected;
  transport.releaseOpen();
  await flush();
  assert.equal(client.snapshot().state, "disconnected");
  assert.equal(transport.writes.length, 0);
});

test("close during open immediately settles connect and late open cannot revive ready", async () => {
  const transport = new DeferredOpenTransport();
  const client = new NativeClient({ transport });
  const connecting = client.connect();
  const rejected = assert.rejects(connecting, (error: unknown) =>
    error instanceof NativeClientError && error.code === "closed");
  const closing = client.close();
  await rejected;
  transport.releaseOpen();
  await closing;
  await flush();
  assert.equal(client.snapshot().state, "closed");
  assert.equal(transport.writes.length, 0);
});

test("connect deadline includes a never-resolving transport open", async () => {
  const runtime = new ManualRuntime();
  const transport = new DeferredOpenTransport();
  const client = new NativeClient({ transport, runtime });
  const connecting = client.connect(25);
  const rejected = assert.rejects(connecting, (error: unknown) =>
    error instanceof NativeClientError && error.code === "deadline");
  runtime.advance(25);
  await rejected;
  assert.equal(client.snapshot().state, "disconnected");
  assert.equal(transport.writes.length, 0);
});

test("connect deadline does not await a stuck close and cleanup is single-flight", async () => {
  class StuckOpenAndCloseTransport extends DeferredOpenTransport {
    closeCalls = 0;
    override close(): Promise<void> {
      this.closeCalls += 1;
      return new Promise(() => {});
    }
  }
  const runtime = new ManualRuntime();
  const transport = new StuckOpenAndCloseTransport();
  const client = new NativeClient({ transport, runtime });
  const connecting = client.connect(10);
  const rejected = assert.rejects(connecting, (error: unknown) =>
    error instanceof NativeClientError && error.code === "deadline");
  runtime.advance(10);
  await rejected;
  await flush();
  assert.equal(transport.closeCalls, 1);
  assert.equal(client.snapshot().state, "disconnected");
});

test("concurrent explicit close calls await the same transport completion", async () => {
  class DeferredCloseTransport extends FakeNativeTransport {
    closeCalls = 0;
    #release: (() => void) | null = null;
    override close(): Promise<void> {
      this.closeCalls += 1;
      return new Promise((resolve) => { this.#release = resolve; });
    }
    releaseClose(): void { this.#release?.(); }
  }
  const automatic = autoTransport();
  const transport = new DeferredCloseTransport(automatic.responder);
  const client = new NativeClient({ transport });
  await client.connect();
  let firstDone = false;
  let secondDone = false;
  const first = client.close().then(() => { firstDone = true; });
  const second = client.close().then(() => { secondDone = true; });
  await flush();
  assert.equal(transport.closeCalls, 1);
  assert.equal(firstDone, false);
  assert.equal(secondDone, false);
  transport.releaseClose();
  await Promise.all([first, second]);
  assert.equal(firstDone, true);
  assert.equal(secondDone, true);
});
