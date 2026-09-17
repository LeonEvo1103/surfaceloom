import assert from "node:assert/strict";
import test from "node:test";
import type {
  NativeLocatorFor,
  SystemDesktopSession,
} from "../../src/desktop-session/contracts.js";
import {
  BoundedDesktopSessionJournal,
  invokeLegacyCompatible,
  retainOperationEvidence,
} from "../../src/desktop-session/evidence-journal.js";
import { JournaledDesktopSessionOperationPort } from "../../src/desktop-session/journaled-port.js";
import { NativeLateAcquisitionMailbox } from "../../src/desktop-session/late-acquisition.js";
import { NativeClient } from "../../src/client/index.js";
import type { HostDescriptor, NativeWireMessage, WireRequest } from "../../src/contracts.js";
import { validateWireMessage } from "../../src/schema.js";
import { FakeNativeTransport, ManualRuntime, flush } from "../client/fake-transport.js";

type SystemHasNoTarget = "target" extends keyof SystemDesktopSession<"macos"> ? false : true;
const systemHasNoTarget: SystemHasNoTarget = true;
void systemHasNoTarget;

test("platform locator and system surface discriminants stay distinct", () => {
  const macLocator: NativeLocatorFor<"macos"> = { backend: "ax", identifier: "save" };
  const windowsLocator: NativeLocatorFor<"windows"> = { backend: "uia", automationId: "save" };
  assert.equal(macLocator.backend, "ax");
  assert.equal(windowsLocator.backend, "uia");
  const systemSurface = (session: SystemDesktopSession<"macos">): string => session.surface;
  void systemSurface;
});

test("journal is bounded and retains only real operation receipts", async () => {
  const journal = new BoundedDesktopSessionJournal(2);
  const identity = { hostInstanceId: "host", sessionId: "session", handleId: "root" };
  await retainOperationEvidence(Promise.resolve({ value: 1,
    operation: { operationId: "one", outcome: "executed" } }), "element.invoke", identity, journal);
  await retainOperationEvidence(Promise.resolve({ value: 2,
    operation: { operationId: "two", outcome: "unknown" } }), "element.invoke", identity, journal);
  await retainOperationEvidence(Promise.resolve({ value: 3,
    operation: { operationId: "three", outcome: "executed" } }), "element.invoke", identity, journal);
  assert.deepEqual(journal.snapshot().map((item) => item.operation?.operationId), ["two", "three"]);

  await invokeLegacyCompatible(async () => undefined);
  assert.equal(journal.snapshot().length, 2, "void fulfillment must not synthesize evidence");
});

test("journaled operation port retains NativeClient success and error receipts", async () => {
  const host: HostDescriptor = { hostInstanceId: "host", platform: "windows", backend: "uia",
    maxMessageBytes: 1_048_576, methods: [
      { name: "host.handshake", intent: "observe", scopeKinds: ["bootstrap"] },
      { name: "session.launch", intent: "lifecycle", scopeKinds: ["host"] },
      { name: "element.action", intent: "mutate", scopeKinds: ["handle"] },
    ] };
  let holdMutation = false;
  const transport = new FakeNativeTransport((message, current) => {
    if (message.type !== "request") return;
    if (message.call.name === "host.handshake") current.receive(success(message, host));
    else if (message.call.name === "session.launch") current.receive(success(message, {
      hostInstanceId: "host", sessionId: "session", ownership: "owned", surface: "application",
      root: { hostInstanceId: "host", sessionId: "session", handleId: "root" },
    }, { operationId: message.call.operationId, outcome: "executed" }));
    else if (!holdMutation) current.receive(success(message, null,
      { operationId: message.call.operationId, outcome: "executed" }));
  });
  const client = new NativeClient({ transport });
  await client.connect();
  const launched = await client.launchSession({ payload: {}, timeoutMs: 100 });
  const journal = new BoundedDesktopSessionJournal();
  const port = new JournaledDesktopSessionOperationPort(client, launched.value.root, journal, () => "auto-lost");
  await port.invoke({ method: "element.action", intent: "mutate", scope: "handle", payload: {},
    timeoutMs: 100, operationId: "invoke-ok", decode: () => null });
  holdMutation = true;
  const failed = port.invoke({ method: "element.action", intent: "mutate", scope: "handle", payload: {},
    timeoutMs: 100, decode: () => null });
  await flush();
  transport.disconnect(new Error("lost"));
  await assert.rejects(failed);
  assert.deepEqual(journal.snapshot().map((item) => [item.status, item.operation?.outcome]), [
    ["success", "executed"], ["error", "unknown"],
  ]);
  assert.equal(journal.snapshot()[1]?.operation?.operationId, "auto-lost");
});

test("journal preserves automatic operation identity for cancellation and timeout", async () => {
  for (const mode of ["cancel", "timeout"] as const) {
    const runtime = new ManualRuntime();
    const transport = new FakeNativeTransport((message, current) => {
      if (message.type !== "request") return;
      if (message.call.name === "host.handshake") current.receive(success(message, hostWithAction()));
      else if (message.call.name === "session.launch") current.receive(success(message, sessionResult(),
        { operationId: message.call.operationId, outcome: "executed" }));
    });
    const client = new NativeClient({ transport, runtime });
    await client.connect();
    const launched = await client.launchSession({ payload: {}, timeoutMs: 100 });
    const journal = new BoundedDesktopSessionJournal();
    const port = new JournaledDesktopSessionOperationPort(client, launched.value.root, journal,
      () => `auto-${mode}`);
    const controller = new AbortController();
    const pending = port.invoke({ method: "element.action", intent: "mutate", scope: "handle", payload: {},
      timeoutMs: 20, signal: controller.signal, decode: () => null });
    await flush();
    if (mode === "cancel") controller.abort(); else runtime.advance(20);
    await assert.rejects(pending);
    assert.deepEqual(journal.snapshot()[0]?.operation, { operationId: `auto-${mode}`, outcome: "unknown" });
    await client.close();
  }
});

test("journal preserves executed receipt and identity when result decode fails", async () => {
  const transport = new FakeNativeTransport((message, current) => {
    if (message.type !== "request") return;
    if (message.call.name === "host.handshake") current.receive(success(message, hostWithAction()));
    else if (message.call.name === "session.launch") current.receive(success(message, sessionResult(),
      { operationId: message.call.operationId, outcome: "executed" }));
    else current.receive(success(message, { invalid: true },
      { operationId: message.call.operationId, outcome: "executed" }));
  });
  const client = new NativeClient({ transport });
  await client.connect();
  const launched = await client.launchSession({ payload: {}, timeoutMs: 100 });
  const journal = new BoundedDesktopSessionJournal();
  const port = new JournaledDesktopSessionOperationPort(client, launched.value.root, journal, () => "auto-decode");
  await assert.rejects(port.invoke({ method: "element.action", intent: "mutate", scope: "handle", payload: {},
    timeoutMs: 100, decode: () => { throw new Error("bad result"); } }));
  assert.deepEqual(journal.snapshot()[0]?.operation, { operationId: "auto-decode", outcome: "executed" });
  await client.close();
});

test("late launch receipt is reconciled through NativeClient fake-transport interleaving", async () => {
  const host: HostDescriptor = { hostInstanceId: "host", platform: "windows", backend: "uia",
    maxMessageBytes: 1_048_576, methods: [
      { name: "host.handshake", intent: "observe", scopeKinds: ["bootstrap"] },
      { name: "session.launch", intent: "lifecycle", scopeKinds: ["host"] },
    ] };
  let launchRequest: WireRequest | undefined;
  const transport = new FakeNativeTransport((message, current) => {
    if (message.type !== "request") return;
    if (message.call.name === "host.handshake") current.receive(success(message, host));
    else launchRequest = message;
  });
  const mailbox = new NativeLateAcquisitionMailbox();
  const client = new NativeClient({ transport, onLateResponse: mailbox.accept });
  await client.connect();
  const controller = new AbortController();
  const launch = client.launchSession({ payload: {}, timeoutMs: 100, signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(launch);
  assert.ok(launchRequest);
  transport.receive(success(launchRequest, { hostInstanceId: "host", sessionId: "late-session",
    ownership: "owned", surface: "application",
    root: { hostInstanceId: "host", sessionId: "late-session", handleId: "late-root" },
  }, { operationId: launchRequest.call.operationId, outcome: "executed" }));
  const reconciled = await mailbox.reconcile(50);
  assert.equal(reconciled?.sessionId, "late-session");
  assert.equal(client.snapshot().trackedSessionCount, 0,
    "late evidence is caller-owned and does not silently revive client tracking");
  await client.close();
});

function success(request: WireRequest, result: unknown, operation: unknown = null): NativeWireMessage {
  return validateWireMessage({ protocol: "surfaceloom.native", version: "1.0", type: "response",
    id: request.id, ok: true, result, operation });
}

function hostWithAction(): HostDescriptor {
  return { hostInstanceId: "host", platform: "windows", backend: "uia", maxMessageBytes: 1_048_576,
    methods: [{ name: "host.handshake", intent: "observe", scopeKinds: ["bootstrap"] },
      { name: "session.launch", intent: "lifecycle", scopeKinds: ["host"] },
      { name: "element.action", intent: "mutate", scopeKinds: ["handle"] }] };
}
function sessionResult(): unknown {
  return { hostInstanceId: "host", sessionId: "session", ownership: "owned", surface: "application",
    root: { hostInstanceId: "host", sessionId: "session", handleId: "root" } };
}
