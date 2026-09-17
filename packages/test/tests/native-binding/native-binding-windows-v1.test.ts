import assert from "node:assert/strict";
import test from "node:test";
import { NativeClient } from "../../../native/src/client/index.js";
import type { HostDescriptor, NativeWireMessage, WireRequest } from "../../../native/src/contracts.js";
import { validateWireMessage } from "../../../native/src/schema.js";
import { FakeNativeTransport } from "../../../native/tests/client/fake-transport.js";
import type { CaseContext } from "../../src/contracts.js";
import { acquireNativeApplication } from "../../src/native-binding/binding.js";
import {
  nativeSessionOperationContracts,
  type NativeBindingPort,
  type NativeOperationContract,
  type NativeSessionIdentity,
} from "../../src/native-binding/contracts.js";
import { ResourceScope } from "../../src/resources.js";

const windowsV1Methods = [
  { name: "session.launch", intent: "lifecycle", scopeKinds: ["host"] },
  { name: "session.attach", intent: "lifecycle", scopeKinds: ["host"] },
  { name: "session.release", intent: "lifecycle", scopeKinds: ["session"] },
  { name: "session.close", intent: "lifecycle", scopeKinds: ["session"] },
  { name: "session.terminate", intent: "lifecycle", scopeKinds: ["session"] },
  { name: "element.find", intent: "observe", scopeKinds: ["session", "handle"] },
  { name: "element.action", intent: "mutate", scopeKinds: ["handle"] },
] as const;

test("logical operations bind to the Windows v1 advertised wire contract", async () => {
  const scope = new ResourceScope({ cleanupTimeoutMs: 100 });
  const calls: { contract: NativeOperationContract; payload: Readonly<Record<string, unknown>> }[] = [];
  const session = identity();
  const port = portFor(session, async <T>(_session: NativeSessionIdentity,
    contract: NativeOperationContract, payload: Readonly<Record<string, unknown>>) => {
    calls.push({ contract, payload });
    return { value: null as T, operation: { operationId: "op", outcome: "executed" } };
  });
  const binding = await acquireNativeApplication({ context: contextFor(scope), port,
    environmentPlatform: "windows",
    environmentCapabilities: ["app.launch", "app.quit", "ui.invoke", "ui.set-value"],
    handshake: { hostInstanceId: "host", hostChildIdentity: "child", platform: "windows",
      backend: "uia", methods: windowsV1Methods } }, "launch");
  await binding.invoke("invoke", { action: "caller-cannot-override" });
  await binding.invoke("setValue", { value: "hello" });
  await binding.invoke("quit");
  assert.deepEqual(calls.map(({ contract, payload }) =>
    [contract.method, contract.intent, contract.scope, payload.action]), [
    ["element.action", "mutate", "handle", "invoke"],
    ["element.action", "mutate", "handle", "setValue"],
    ["session.close", "lifecycle", "session", undefined],
  ]);
  assert.equal(nativeSessionOperationContracts.terminate.method, "session.terminate");
  await scope.close();
});

test("NativeClient.close completes before the cleanup barrier permits lease release", async () => {
  const descriptor: HostDescriptor = { hostInstanceId: "host", platform: "windows", backend: "uia",
    maxMessageBytes: 1_048_576,
    methods: [{ name: "host.handshake", intent: "observe", scopeKinds: ["bootstrap"] }] };
  const transport = new FakeNativeTransport((message, current) => {
    if (message.type === "request") current.receive(success(message, descriptor));
  });
  const client = new NativeClient({ transport });
  await client.connect(100_000);
  const scope = new ResourceScope({ cleanupTimeoutMs: 100 });
  const session = identity();
  const events: string[] = [];
  const port = portFor(session);
  port.closeHost = async () => {
    await client.close();
    events.push("client.close");
    return { kind: "hostChildExit", hostInstanceId: "host", hostChildIdentity: "child" };
  };
  await acquireNativeApplication({ context: contextFor(scope), port, environmentPlatform: "windows",
    environmentCapabilities: ["app.launch"],
    handshake: { hostInstanceId: "host", hostChildIdentity: "child", platform: "windows",
      backend: "uia", methods: windowsV1Methods },
    lease: { directory: "/tmp", name: "gui", pid: 1, processCreationMarker: "marker",
      ownerNonce: "owner", leaseToken: "lease", acquiredAt: new Date(0).toISOString(),
      path: "/tmp/lease", diagnostics: [], release: async () => {
        assert.equal(transport.closed, true);
        events.push("lease");
        return { status: "released" };
      } } }, "launch");
  assert.equal((await scope.close()).status, "passed");
  assert.deepEqual(events, ["client.close", "lease"]);
});

function portFor(session: NativeSessionIdentity,
  invoke: NativeBindingPort["invoke"] = async <T>() => ({ value: null as T, operation: null })):
NativeBindingPort {
  return { acquire: async () => ({ value: session,
    operation: { operationId: "launch", outcome: "executed" } }),
  reconcileLateAcquisition: async () => null, invoke,
  cleanupTarget: async () => ({ kind: "targetExit", hostInstanceId: "host",
    sessionId: "session", targetIdentity: "target" }),
  releaseProtocol: async () => ({ kind: "sessionRelease", hostInstanceId: "host", sessionId: "session" }),
  closeHost: async () => ({ kind: "hostChildExit", hostInstanceId: "host", hostChildIdentity: "child" }) };
}
function identity(): NativeSessionIdentity {
  return { hostInstanceId: "host", sessionId: "session", handleId: "root",
    targetIdentity: "target", ownership: "owned", surface: "application" };
}
function contextFor(scope: ResourceScope): CaseContext {
  return { signal: new AbortController().signal, remainingMs: () => 1_000,
    throwIfCancelled: () => undefined, acknowledgeCancellation: () => false,
    fixture: () => { throw new Error("unused"); }, step: async (_step, body) => body(),
    criterion: async (_id, check) => check(), registerResource: (resource) => scope.register(resource),
    dispatch: async (_effect, action) => action(_effect) } as CaseContext;
}
function success(request: WireRequest, result: unknown): NativeWireMessage {
  return validateWireMessage({ protocol: "surfaceloom.native", version: "1.0", type: "response",
    id: request.id, ok: true, result, operation: null });
}
