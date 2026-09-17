import assert from "node:assert/strict";
import test from "node:test";
import { defineExecutionPlan } from "../../src/plan.js";
import { executeCase } from "../../src/execute.js";
import { acquireNativeApplication } from "../../src/native-binding/binding.js";
import {
  nativeAcquisitionContracts,
  nativeSessionOperationContracts,
  type NativeBindingPort,
  type NativeOperationContract,
  type NativeSessionIdentity,
} from "../../src/native-binding/contracts.js";
import { spec } from "../support.js";

test("real executeCase dispatch authorizes native writes and cleans identity-bound resources", async () => {
  const calls: string[] = [];
  const session: NativeSessionIdentity = { hostInstanceId: "host", sessionId: "session",
    handleId: "root", targetIdentity: "pid:42:start:7", ownership: "owned", surface: "application" };
  const port: NativeBindingPort = {
    acquire: async () => { calls.push("launch"); return { value: session,
      operation: { operationId: "launch-op", outcome: "executed" } }; },
    reconcileLateAcquisition: async () => null,
    invoke: async <T>(_session: NativeSessionIdentity, contract: NativeOperationContract) => { calls.push(contract.method);
      return { value: null as T, operation: { operationId: "invoke-op", outcome: "executed" } }; },
    cleanupTarget: async () => { calls.push("target"); return { kind: "targetExit",
      hostInstanceId: "host", sessionId: "session", targetIdentity: "pid:42:start:7" }; },
    releaseProtocol: async () => { calls.push("protocol");
      return { kind: "sessionRelease", hostInstanceId: "host", sessionId: "session" }; },
    closeHost: async () => { calls.push("host");
      return { kind: "hostChildExit", hostInstanceId: "host", hostChildIdentity: "child:9:start:2" }; },
  };
  const caseSpec = { ...spec("native.binding.execute"), platforms: ["macos"] as const,
    sideEffect: "writesLocal" as const };
  const effects = [nativeAcquisitionContracts.launch.effect, nativeSessionOperationContracts.invoke.effect];
  const report = await executeCase({ spec: caseSpec, run: async (context) => {
    const binding = await acquireNativeApplication({ context, environmentPlatform: "macos",
      environmentCapabilities: ["app.launch", "ui.invoke"], port,
      handshake: { hostInstanceId: "host", hostChildIdentity: "child:9:start:2",
        platform: "macos", backend: "ax", methods: [
          { name: "session.launch", intent: "lifecycle", scopeKinds: ["host"] },
          { name: "element.action", intent: "mutate", scopeKinds: ["handle"] },
        ] } }, "launch");
    await binding.invoke("invoke");
    await context.criterion("verified", () => assert.equal(calls.includes("element.action"), true));
  } }, { platform: "macos",
    plan: defineExecutionPlan({ spec: caseSpec, requirements: { surfaces: {
      native: { kind: "desktop", capabilities: ["app.launch", "ui.invoke"] },
    } }, effects }),
    environment: { platform: "macos", host: { os: "macos" }, surfaces: {
      native: { kind: "desktop", capabilities: ["app.launch", "ui.invoke"] },
    } },
    policy: { grants: [
      { resource: "native.app.launch", operations: ["execute"], allowUnknownRecovery: true },
      { resource: "native.ui.invoke", operations: ["write"], allowUnknownRecovery: true },
    ] },
  });
  assert.equal(report.result.status, "passed");
  assert.deepEqual(calls, ["launch", "element.action", "target", "protocol", "host"]);
});
