import assert from "node:assert/strict";
import test from "node:test";
import type { CaseContext } from "../../src/contracts.js";
import { acquireNativeApplication } from "../../src/native-binding/binding.js";
import type {
  NativeBindingPort,
  NativeSessionIdentity,
} from "../../src/native-binding/contracts.js";
import { ResourceScope } from "../../src/resources.js";

for (const kind of ["launch", "attach"] as const) {
  for (const ownsProtocol of [false, true]) {
    for (const ownsHost of [false, true]) {
      test(`${kind} cleanup covers protocol=${ownsProtocol} host=${ownsHost}`, async () => {
        const scope = new ResourceScope({ cleanupTimeoutMs: 50 });
        const context = contextFor(scope);
        const calls: string[] = [];
        const session = identity(kind === "launch" ? "owned" : "borrowed");
        const port: NativeBindingPort = {
          acquire: async () => ({ value: session,
            operation: { operationId: "acquire", outcome: "executed" } }),
          reconcileLateAcquisition: async () => null,
          invoke: async <T>() => ({ value: null as T, operation: null }),
          cleanupTarget: async () => { calls.push("target"); return { kind: "targetExit",
            hostInstanceId: "host", sessionId: session.sessionId, targetIdentity: session.targetIdentity }; },
          releaseProtocol: async () => { calls.push("protocol");
            return { kind: "sessionRelease", hostInstanceId: "host", sessionId: session.sessionId }; },
          closeHost: async () => { calls.push("host");
            return { kind: "hostChildExit", hostInstanceId: "host", hostChildIdentity: "child" }; },
        };
        await acquireNativeApplication({ context, port, ownsProtocol, ownsHost,
          environmentPlatform: "macos", environmentCapabilities: [kind === "launch" ? "app.launch" : "app.attach"],
          handshake: { hostInstanceId: "host", hostChildIdentity: "child", platform: "macos", backend: "ax",
            methods: [{ name: `session.${kind}`, intent: "lifecycle", scopeKinds: ["host"] }] },
          lease: { directory: "/tmp", name: "gui", pid: 1, processCreationMarker: "marker",
            ownerNonce: "owner", leaseToken: `${kind}-${ownsProtocol}-${ownsHost}`,
            acquiredAt: new Date(0).toISOString(), path: "/tmp/lease", diagnostics: [],
            release: async () => { calls.push("lease"); return { status: "released" }; } },
        }, kind);
        const result = await scope.close();
        assert.equal(result.status, "passed");
        assert.deepEqual(calls, [
          ...(kind === "launch" ? ["target"] : []),
          ...(ownsProtocol ? ["protocol"] : []),
          ...(ownsHost ? ["host"] : []),
          "lease",
        ]);
      });
    }
  }
}

test("unknown launch reconciles one late identity before native cleanup", async () => {
  const scope = new ResourceScope({ cleanupTimeoutMs: 100 });
  const context = contextFor(scope);
  const calls: string[] = [];
  const session = identity("owned");
  const port: NativeBindingPort = {
    acquire: async () => { calls.push("launch");
      throw Object.assign(new Error("unknown launch"), { operationOutcome: "unknown" }); },
    reconcileLateAcquisition: async () => { calls.push("reconcile"); return session; },
    invoke: async <T>() => ({ value: null as T, operation: null }),
    cleanupTarget: async () => { calls.push("target"); return { kind: "targetExit",
      hostInstanceId: "host", sessionId: session.sessionId, targetIdentity: session.targetIdentity }; },
    releaseProtocol: async () => { calls.push("protocol");
      return { kind: "sessionRelease", hostInstanceId: "host", sessionId: session.sessionId }; },
    closeHost: async () => { calls.push("host");
      return { kind: "hostChildExit", hostInstanceId: "host", hostChildIdentity: "child" }; },
  };
  await assert.rejects(acquireNativeApplication({ context, port, environmentPlatform: "macos",
    environmentCapabilities: ["app.launch"], reconciliationTimeoutMs: 50,
    handshake: { hostInstanceId: "host", hostChildIdentity: "child", platform: "macos", backend: "ax",
      methods: [{ name: "session.launch", intent: "lifecycle", scopeKinds: ["host"] }] },
  }, "launch"), /unknown launch/);
  const result = await scope.close();
  assert.equal(result.status, "passed");
  assert.deepEqual(calls, ["launch", "reconcile", "target", "protocol", "host"]);
});

function identity(ownership: NativeSessionIdentity["ownership"]): NativeSessionIdentity {
  return { hostInstanceId: "host", sessionId: `session-${ownership}`, handleId: "root",
    targetIdentity: `target-${ownership}`, ownership, surface: "application" };
}

function contextFor(scope: ResourceScope): CaseContext {
  return { signal: new AbortController().signal, remainingMs: () => 1_000,
    throwIfCancelled: () => undefined, acknowledgeCancellation: () => false,
    fixture: () => { throw new Error("unused"); },
    step: async (_step, body) => body(), criterion: async (_id, check) => check(),
    registerResource: (resource) => scope.register(resource),
    dispatch: async (_effect, action) => action(_effect),
  } as CaseContext;
}
