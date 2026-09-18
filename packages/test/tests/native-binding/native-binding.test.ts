import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopCapability } from "@surfaceloom/core";
import type { CaseContext } from "../../src/contracts.js";
import type { EffectDescriptor } from "../../src/effects.js";
import type { InteractiveSessionLease } from "../../src/interactive-session-contracts.js";
import { acquireNativeApplication } from "../../src/native-binding/binding.js";
import {
  NativeBindingError,
  type NativeBindingOptions,
  type NativeBindingPort,
  type NativeOperationResult,
  type NativeSessionIdentity,
} from "../../src/native-binding/contracts.js";
import { ResourceScope } from "../../src/resources.js";

const allCapabilities: readonly DesktopCapability[] = [
  "app.launch", "app.attach", "app.quit", "app.terminate", "ui.inspect", "ui.invoke", "ui.set-value",
];
const allMethods = [
  { name: "session.launch", intent: "lifecycle", scopeKinds: ["host"] },
  { name: "session.attach", intent: "lifecycle", scopeKinds: ["host"] },
  { name: "session.close", intent: "lifecycle", scopeKinds: ["session"] },
  { name: "session.terminate", intent: "lifecycle", scopeKinds: ["session"] },
  { name: "element.find", intent: "observe", scopeKinds: ["session"] },
  { name: "element.action", intent: "mutate", scopeKinds: ["handle"] },
] as const;

function identity(ownership: "owned" | "borrowed"): NativeSessionIdentity {
  return Object.freeze({ hostInstanceId: "host-1", sessionId: `session-${ownership}`,
    handleId: "root", targetIdentity: `target-${ownership}`, ownership, surface: "application" });
}

function executed<T>(value: T): NativeOperationResult<T> {
  return Object.freeze({ value, operation: Object.freeze({ operationId: "operation", outcome: "executed" }) });
}

function harness(dispatch?: CaseContext["dispatch"]): { context: CaseContext; scope: ResourceScope } {
  const scope = new ResourceScope({ cleanupTimeoutMs: 100 });
  const context = {
    signal: new AbortController().signal,
    remainingMs: () => 1_000,
    throwIfCancelled: () => undefined,
    acknowledgeCancellation: () => false,
    fixture: () => { throw new Error("unused"); },
    step: async (_step: unknown, body: () => unknown) => body(),
    criterion: async (_id: string, check: () => unknown) => check(),
    registerResource: (resource: Parameters<ResourceScope["register"]>[0]) => scope.register(resource),
    dispatch: dispatch ?? (async <T>(_effect: EffectDescriptor,
      action: (effect: Readonly<EffectDescriptor>) => T | Promise<T>) => action(_effect)),
  } as CaseContext;
  return { context, scope };
}

function fakePort(overrides: Partial<NativeBindingPort> = {}): NativeBindingPort & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign({
    calls,
    acquire: async (kind: "launch" | "attach") => {
      calls.push(kind); return executed(identity(kind === "launch" ? "owned" : "borrowed"));
    },
    reconcileLateAcquisition: async () => null,
    invoke: async <T>() => { calls.push("invoke"); return executed(null as T); },
    cleanupTarget: async (session: NativeSessionIdentity) => { calls.push("target");
      return { kind: "targetExit", hostInstanceId: session.hostInstanceId,
        sessionId: session.sessionId, targetIdentity: session.targetIdentity }; },
    releaseProtocol: async (session: NativeSessionIdentity) => { calls.push("protocol");
      return { kind: "sessionRelease", hostInstanceId: session.hostInstanceId, sessionId: session.sessionId }; },
    closeHost: async () => { calls.push("host");
      return { kind: "hostChildExit", hostInstanceId: "host-1", hostChildIdentity: "child-1" }; },
  }, overrides);
}

function options(context: CaseContext, port: NativeBindingPort,
  methods: NativeBindingOptions["handshake"]["methods"] = allMethods): NativeBindingOptions {
  return { context, port, environmentPlatform: "macos", environmentCapabilities: allCapabilities,
    handshake: { hostInstanceId: "host-1", hostChildIdentity: "child-1",
      platform: "macos", backend: "ax", methods } };
}

test("policy denial and capability mismatch perform zero business writes", async () => {
  const denied = harness(async () => { throw new Error("denied"); });
  const deniedPort = fakePort();
  await assert.rejects(acquireNativeApplication(options(denied.context, deniedPort), "launch",
    { timeoutMs: 100 }), /denied/);
  assert.deepEqual(deniedPort.calls, []);
  await denied.scope.close();

  const missing = harness();
  const missingPort = fakePort();
  await assert.rejects(acquireNativeApplication(options(missing.context, missingPort, [allMethods[1]]),
    "launch", { timeoutMs: 100 }), (error: unknown) =>
    error instanceof NativeBindingError && error.code === "capabilityMismatch");
  assert.deepEqual(missingPort.calls, []);
  await missing.scope.close();
});

test("ownership, stale scope, and pre-abort are rejected before invoke", async () => {
  const attached = harness();
  const port = fakePort();
  const binding = await acquireNativeApplication(options(attached.context, port), "attach", { timeoutMs: 100 });
  port.calls.length = 0;
  await assert.rejects((binding.invoke as (operation: string) => Promise<unknown>)("terminate"), (error: unknown) =>
    error instanceof NativeBindingError && error.code === "wrongOwnership");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(binding.invoke("find", {}, { signal: controller.signal }), (error: unknown) =>
    error instanceof NativeBindingError && error.code === "aborted");
  await assert.rejects(binding.invoke("launch" as never), (error: unknown) =>
    error instanceof NativeBindingError && error.code === "invalidOperation");
  (options as unknown); // keep the fixture-independent binding surface explicit
  assert.deepEqual(port.calls, []);
  await attached.scope.close();

  const stale = harness();
  const stalePort = fakePort();
  const mutable = options(stale.context, stalePort);
  const staleBinding = await acquireNativeApplication(mutable, "launch", { timeoutMs: 100 });
  (mutable.handshake as { hostInstanceId: string }).hostInstanceId = "host-2";
  stalePort.calls.length = 0;
  await assert.rejects(staleBinding.invoke("find"), (error: unknown) =>
    error instanceof NativeBindingError && error.code === "staleScope");
  assert.deepEqual(stalePort.calls, []);
  await stale.scope.close();
});

test("unknown acquisition is not retried and borrowed targets are never killed", async () => {
  const unknown = harness();
  let launches = 0;
  const unknownPort = fakePort({ acquire: async () => {
    launches += 1;
    throw Object.assign(new Error("lost"), { operationOutcome: "unknown" });
  } });
  await assert.rejects(acquireNativeApplication(options(unknown.context, unknownPort), "launch",
    { timeoutMs: 100 }), /lost/);
  const unknownCleanup = await unknown.scope.close();
  assert.equal(launches, 1);
  assert.equal(unknownCleanup.status, "failed");

  const borrowed = harness();
  const borrowedPort = fakePort();
  await acquireNativeApplication(options(borrowed.context, borrowedPort), "attach", { timeoutMs: 100 });
  await borrowed.scope.close();
  assert.equal(borrowedPort.calls.includes("target"), false);
});

test("late launch is cleaned in order before the GUI lease is released", async () => {
  const run = harness();
  let settle!: (result: NativeOperationResult<NativeSessionIdentity>) => void;
  const pending = new Promise<NativeOperationResult<NativeSessionIdentity>>((resolve) => { settle = resolve; });
  const port = fakePort({ acquire: async () => pending });
  const lease = fakeLease(port.calls);
  const acquiring = acquireNativeApplication({ ...options(run.context, port), lease }, "launch", { timeoutMs: 100 });
  const closing = run.scope.close();
  settle(executed(identity("owned")));
  await acquiring;
  const result = await closing;
  assert.equal(result.status, "passed");
  assert.deepEqual(port.calls, ["target", "protocol", "host", "lease"]);
});

test("an unconfirmed native barrier retains the GUI lease", async () => {
  const run = harness();
  const port = fakePort({ cleanupTarget: async () => {
    port.calls.push("target");
    return { kind: "targetExit", hostInstanceId: "wrong-host",
      sessionId: "session-owned", targetIdentity: "target-owned" };
  } });
  const lease = fakeLease(port.calls);
  await acquireNativeApplication({ ...options(run.context, port), lease }, "launch", { timeoutMs: 100 });
  port.calls.length = 0;
  const result = await run.scope.close();
  assert.equal(result.status, "failed");
  assert.deepEqual(port.calls, ["target", "protocol", "host"]);
  assert.equal(result.outcomes.find((item) => item.id.startsWith("native.gui-lease"))?.status, "unconfirmed");
});

test("a rejected target cleanup does not skip later native cleanup attempts", async () => {
  for (const synchronous of [false, true]) {
    const run = harness();
    let port!: ReturnType<typeof fakePort>;
    const failure = () => { port.calls.push("target"); throw new Error("target cleanup failed"); };
    port = fakePort({ cleanupTarget: synchronous ? failure : async () => failure() });
    const lease = fakeLease(port.calls);
    await acquireNativeApplication({ ...options(run.context, port), lease }, "launch", { timeoutMs: 100 });
    port.calls.length = 0;
    const result = await run.scope.close();
    assert.equal(result.status, "failed");
    assert.deepEqual(port.calls, ["target", "protocol", "host"]);
  }
});

test("operation receipts and wrong cleanup identities never release the GUI lease", async () => {
  for (const cleanup of [
    async () => executed(null) as unknown as Awaited<ReturnType<NativeBindingPort["cleanupTarget"]>>,
    async () => ({ kind: "targetExit", hostInstanceId: "host-1", sessionId: "wrong",
      targetIdentity: "target-owned" } as const),
    async () => undefined,
  ]) {
    const run = harness();
    const port = fakePort({ cleanupTarget: cleanup });
    const lease = fakeLease(port.calls);
    await acquireNativeApplication({ ...options(run.context, port), lease }, "launch", { timeoutMs: 100 });
    port.calls.length = 0;
    const result = await run.scope.close();
    assert.equal(result.status, "failed");
    assert.equal(port.calls.includes("lease"), false);
    assert.equal(port.calls.includes("protocol"), true);
    assert.equal(port.calls.includes("host"), true);
  }
});

test("borrowed gaps do not bypass a hanging owned layer", async () => {
  const run = harness();
  let settle!: (value: Awaited<ReturnType<NativeBindingPort["cleanupTarget"]>>) => void;
  const hanging = new Promise<Awaited<ReturnType<NativeBindingPort["cleanupTarget"]>>>((resolve) => { settle = resolve; });
  const port = fakePort({ cleanupTarget: async () => { port.calls.push("target"); return hanging; } });
  const lease = fakeLease(port.calls);
  await acquireNativeApplication({ ...options(run.context, port), ownsProtocol: false,
    cleanupSettleTimeoutMs: 10, lease },
    "launch", { timeoutMs: 100 });
  port.calls.length = 0;
  const result = await run.scope.close();
  assert.equal(result.status, "failed");
  assert.deepEqual(port.calls, ["target", "host"]);
  settle({ kind: "targetExit", hostInstanceId: "host-1", sessionId: "session-owned",
    targetIdentity: "target-owned" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.calls.includes("lease"), false, "a late proof cannot make a published failure reusable");
});

test("adapter-owned host registration supports namespaced target and protocol cleanup", async () => {
  const run = harness();
  const port = fakePort();
  await acquireNativeApplication({ ...options(run.context, port), ownsHost: false,
    registerHostResource: false, resourceNamespace: "native.desktop.session" },
  "launch", { timeoutMs: 100 });
  port.calls.length = 0;
  const result = await run.scope.close();
  assert.equal(result.status, "passed");
  assert.deepEqual(port.calls, ["target", "protocol"]);
  assert.deepEqual(result.outcomes.map((item) => item.id), [
    "native.desktop.session.target",
    "native.desktop.session.protocol",
    "native.desktop.session.cleanup-barrier",
  ]);
});

function fakeLease(events: string[]): InteractiveSessionLease {
  return { directory: "/tmp", name: "gui", pid: 1, processCreationMarker: "marker",
    ownerNonce: "owner", leaseToken: "lease", acquiredAt: new Date(0).toISOString(), path: "/tmp/lease",
    diagnostics: [], release: async () => { events.push("lease"); return { status: "released" }; } };
}
