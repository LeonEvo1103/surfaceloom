import assert from "node:assert/strict";
import test from "node:test";
import type { CaseContext } from "../../src/contracts.js";
import { acquireNativeApplication } from "../../src/native-binding/binding.js";
import type { NativeBindingPort, NativeSessionIdentity } from "../../src/native-binding/contracts.js";
import { DeferredNativeAcquisition, registerNativeResources } from "../../src/native-binding/resources.js";
import { ResourceScope } from "../../src/resources.js";

for (const delayedLayer of ["target", "protocol", "host"] as const) {
  test(`a synchronous ${delayedLayer} proof after its absolute deadline stays unconfirmed`, async () => {
    const scope = new ResourceScope({ cleanupTimeoutMs: 100 });
    const session = identity();
    const calls: string[] = [];
    const port = portFor(session, calls, delayedLayer);
    await acquireNativeApplication({ context: contextFor(scope), port,
      cleanupSettleTimeoutMs: 5, environmentPlatform: "windows",
      environmentCapabilities: ["app.launch"], handshake: {
        hostInstanceId: "host", hostChildIdentity: "child", platform: "windows", backend: "uia",
        methods: [{ name: "session.launch", intent: "lifecycle", scopeKinds: ["host"] }],
      }, lease: { directory: "/tmp", name: "gui", pid: 1, processCreationMarker: "marker",
        ownerNonce: "owner", leaseToken: `lease-${delayedLayer}`,
        acquiredAt: new Date(0).toISOString(), path: "/tmp/lease", diagnostics: [],
        release: async () => { calls.push("lease"); return { status: "released" }; } },
    }, "launch");
    calls.length = 0;
    const result = await scope.close();
    assert.equal(result.status, "failed");
    assert.deepEqual(calls, ["target", "protocol", "host"]);
    assert.match(result.failures.map((item) => item.message).join("\n"), /timed out/);
  });
}

for (const fault of [
  { name: "non-finite", values: [Number.NaN] },
  { name: "backwards", values: [10, 5, 20, 21, 30, 31] },
] as const) {
  test(`${fault.name} cleanup clocks fail closed while later cleanup is attempted`, async () => {
    let index = 0;
    const outcome = await runWithClock(() => fault.values[index++] ?? 40);
    assert.equal(outcome.result.status, "failed");
    assert.deepEqual(outcome.calls, ["target", "protocol", "host"]);
    assert.match(outcome.result.failures.map((item) => item.message).join("\n"), /clock/);
  });
}

test("a throwing cleanup clock fails closed while later cleanup is attempted", async () => {
  const outcome = await runWithClock(() => { throw new Error("clock failure"); });
  assert.equal(outcome.result.status, "failed");
  assert.deepEqual(outcome.calls, ["target", "protocol", "host"]);
  assert.match(outcome.result.failures.map((item) => item.message).join("\n"), /clock/);
});

test("invalid cleanup budgets reject before acquisition or resource registration", async () => {
  for (const cleanupSettleTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2_147_483_648]) {
    const scope = new ResourceScope({ cleanupTimeoutMs: 100 });
    const calls: string[] = [];
    await assert.rejects(acquireNativeApplication({ context: contextFor(scope),
      port: portFor(identity(), calls), cleanupSettleTimeoutMs,
      environmentPlatform: "windows", environmentCapabilities: ["app.launch"],
      handshake: handshake(),
    }, "launch"), /safe integer/);
    assert.deepEqual(calls, []);
    assert.equal((await scope.close()).status, "passed");
  }
});

test("the direct resource registration entry validates cleanup budget before all work", () => {
  for (const cleanupSettleTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2_147_483_648]) {
    let registrations = 0;
    const calls: string[] = [];
    assert.throws(() => registerNativeResources({
      context: registrationContext(() => { registrations += 1; }),
      acquisition: new DeferredNativeAcquisition(), handshake: handshake(),
      port: portFor(identity(), calls), targetOwnership: "owned", ownsProtocol: true, ownsHost: true,
      cleanupSettleTimeoutMs,
    }), /safe integer/);
    assert.equal(registrations, 0);
    assert.deepEqual(calls, []);
  }
  for (const cleanupSettleTimeoutMs of [0, 2_147_483_647]) {
    let registrations = 0;
    registerNativeResources({ context: registrationContext(() => { registrations += 1; }),
      acquisition: new DeferredNativeAcquisition(), handshake: handshake(),
      port: portFor(identity(), []), targetOwnership: "owned", ownsProtocol: true, ownsHost: true,
      cleanupSettleTimeoutMs });
    assert.equal(registrations, 4);
  }
});

async function runWithClock(now: () => number): Promise<{
  result: Awaited<ReturnType<ResourceScope["close"]>>; calls: string[];
}> {
  const scope = new ResourceScope({ cleanupTimeoutMs: 100 });
  const calls: string[] = [];
  await acquireNativeApplication({ context: contextFor(scope), port: portFor(identity(), calls),
    cleanupSettleTimeoutMs: 50, cleanupClock: { now }, environmentPlatform: "windows",
    environmentCapabilities: ["app.launch"], handshake: handshake(),
    lease: lease(calls, "clock") }, "launch");
  calls.length = 0;
  return { result: await scope.close(), calls };
}

function portFor(session: NativeSessionIdentity, calls: string[],
  delayedLayer?: "target" | "protocol" | "host"): NativeBindingPort {
  return { acquire: async () => { calls.push("acquire"); return { value: session,
    operation: { operationId: "launch", outcome: "executed" } }; },
  reconcileLateAcquisition: async () => null,
  invoke: async <T>() => ({ value: null as T, operation: null }),
  cleanupTarget: async () => { calls.push("target");
    if (delayedLayer === "target") busyWait(30);
    return { kind: "targetExit", hostInstanceId: "host", sessionId: "session", targetIdentity: "target" }; },
  releaseProtocol: async () => { calls.push("protocol");
    if (delayedLayer === "protocol") busyWait(30);
    return { kind: "sessionRelease", hostInstanceId: "host", sessionId: "session" }; },
  closeHost: async () => { calls.push("host");
    if (delayedLayer === "host") busyWait(30);
    return { kind: "hostChildExit", hostInstanceId: "host", hostChildIdentity: "child" }; } };
}

function handshake() {
  return { hostInstanceId: "host", hostChildIdentity: "child", platform: "windows" as const,
    backend: "uia", methods: [{ name: "session.launch", intent: "lifecycle" as const,
      scopeKinds: ["host" as const] }] };
}
function lease(calls: string[], suffix: string) {
  return { directory: "/tmp", name: "gui", pid: 1, processCreationMarker: "marker",
    ownerNonce: "owner", leaseToken: `lease-${suffix}`, acquiredAt: new Date(0).toISOString(),
    path: "/tmp/lease", diagnostics: [], release: async () => {
      calls.push("lease"); return { status: "released" as const };
    } };
}

function busyWait(milliseconds: number): void {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) { /* intentionally blocks the timer queue */ }
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
function registrationContext(register: () => void): CaseContext {
  return { signal: new AbortController().signal, remainingMs: () => 1_000,
    throwIfCancelled: () => undefined, acknowledgeCancellation: () => false,
    fixture: () => { throw new Error("unused"); }, step: async (_step, body) => body(),
    criterion: async (_id, check) => check(), registerResource: register,
    dispatch: async (_effect, action) => action(_effect) } as CaseContext;
}
