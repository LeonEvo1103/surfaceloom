import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { defineFixture } from "@surfaceloom/core";

import {
  acquireWindowsExecutionGuiGateForTest,
  observeWindowsExecutionGuiGateQuarantineForTest,
  recoverWindowsExecutionGuiGateQuarantineForTest,
  windowsExecutionGuiGateLocationForTest,
  type WindowsExecutionGuiGateTestRuntime,
} from "../src/execution-gate.js";
import { defineCaseV3 } from "../src/definition-v3.js";
import { defineExecutionPlan } from "../src/plan.js";
import { InteractiveSessionLeaseError } from "../src/interactive-session.js";
import { runCaseV3 } from "../src/runner-v3.js";
import type { CaseContextV3, RunCaseV3Options } from "../src/runner-v3-contracts.js";
import type { ExecutionGuiGate } from "../src/execution-gate.js";
import type { NativeSurfaceBackendPort } from "../src/surfaces/contracts.js";
import { GateChild } from "./execution-gate-support.js";

const sid = "S-1-5-21-100-200-300-1001";

test("native-only and mixed normalize to one user/session/default-desktop scope", async (t) => {
  const runtime = await testRuntime(t);
  const left = windowsExecutionGuiGateLocationForTest(scope(7), runtime);
  const right = windowsExecutionGuiGateLocationForTest({ ...scope(7), userSid: sid.toLowerCase(),
    desktop: " default " }, runtime);
  assert.deepEqual(left, right);
  const isolatedStorage = windowsExecutionGuiGateLocationForTest(scope(7), await testRuntime(t));
  assert.equal(isolatedStorage.id, left.id, "test storage isolation must not change gate identity");
  assert.equal(isolatedStorage.name, left.name);
  assert.notEqual(isolatedStorage.directory, left.directory);
  assert.doesNotMatch(left.name, /run|checkout|tmp/u);
  assert.throws(() => windowsExecutionGuiGateLocationForTest({ ...scope(7), desktop: "secure" }, runtime),
    /default desktop/u);
  assert.throws(() => windowsExecutionGuiGateLocationForTest(scope(7), {
    platform: "darwin", localAppData: runtime.localAppData,
  } as never), /runtime must be win32/u);
});

test("independent contender waits, then enters only after owner release", async (t) => {
  const runtime = await testRuntime(t);
  const config = { runtime, scope: scope(12), spawnTarget: false };
  const owner = GateChild.start(config);
  t.after(async () => { await owner.terminate(); });
  assert.deepEqual(await owner.next(), { type: "waiting" });
  assert.equal((await owner.next() as { type: string }).type, "acquired");
  const contender = GateChild.start(config);
  t.after(async () => { await contender.terminate(); });
  assert.deepEqual(await contender.next(), { type: "waiting" });
  await assert.rejects(contender.next(60), /Timed out/u);
  owner.send("release");
  assert.equal((await owner.next() as { type: string }).type, "released");
  assert.equal((await contender.next() as { type: string }).type, "acquired");
  contender.send("release");
  assert.equal((await contender.next() as { type: string }).type, "released");
});

test("persistent quarantine metadata is one canonical bounded JSON record", async (t) => {
  const runtime = await testRuntime(t);
  const configured = scope(18);
  const location = windowsExecutionGuiGateLocationForTest(configured, runtime);
  const gate = await acquireWindowsExecutionGuiGateForTest(configured, runtime);
  const quarantine = path.join(location.directory, `${location.name}.quarantine`);
  const active = (await readdir(quarantine)).filter((entry) => /^active-.*\.json$/u.test(entry));
  assert.equal(active.length, 1);
  const source = await readFile(path.join(quarantine, active[0]!), "utf8");
  assert.ok(Buffer.byteLength(source) <= 4_096);
  assert.equal(`${JSON.stringify(JSON.parse(source))}\n`, source);
  assert.equal((await gate.release()).status, "released");
});

test("cancelled gate waiter cannot move or release the current owner", async (t) => {
  const runtime = await testRuntime(t);
  const configured = scope(19);
  const owner = await acquireWindowsExecutionGuiGateForTest(configured, runtime);
  const cancellation = new AbortController();
  const waiting = acquireWindowsExecutionGuiGateForTest({ ...configured, timeoutMs: 1_000,
    retryIntervalMs: 5, signal: cancellation.signal }, runtime);
  setTimeout(() => cancellation.abort(), 20);
  await assert.rejects(waiting, (error: unknown) => error instanceof InteractiveSessionLeaseError
    && error.code === "aborted");
  assert.equal((await owner.release()).status, "released");
  const successor = await acquireWindowsExecutionGuiGateForTest(configured, runtime);
  assert.equal((await successor.release()).status, "released");
});

test("final barrier releases after browser, native host, and fixture teardown", async (t) => {
  const root = await temporary(t);
  const events: string[] = [];
  const definition = caseDefinition("mixed", events, false);
  let configured!: RunCaseV3Options;
  const gate: ExecutionGuiGate = { id: "test.gate.final-barrier", release: async () => {
    await stat(path.join(configured.outputDirectory, "complete.json"));
    events.push("GATE_RELEASED"); return { status: "released" };
  }, quarantine: () => { events.push("GATE_QUARANTINED"); } };
  configured = options(root, definition, gate, events, false, true);
  const result = await runCaseV3(definition, configured);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(events, ["browser", "native-session", "native-host", "fixture", "GATE_RELEASED"]);
});

test("fixture teardown failure quarantines only after every cleanup attempt", async (t) => {
  const root = await temporary(t);
  const events: string[] = [];
  const gate = recordedGate(events);
  const definition = caseDefinition("fixture-failed", events, true);
  const result = await runCaseV3(definition, options(root, definition, gate, events, false, false));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(events, ["native-session", "native-host", "fixture", "GATE_QUARANTINED"]);
  assert.equal(events.includes("GATE_RELEASED"), false);
});

test("unconfirmed host cleanup persists quarantine and blocks a successor", async (t) => {
  const runtime = await testRuntime(t);
  const root = await temporary(t);
  const owned = await acquireWindowsExecutionGuiGateForTest(scope(33), runtime);
  const definition = caseDefinition("unconfirmed", [], false);
  const result = await runCaseV3(definition, options(root, definition, owned, [], true, false));
  assert.equal(result.exitCode, 1);
  await assert.rejects(acquireWindowsExecutionGuiGateForTest({ ...scope(33), timeoutMs: 300,
    retryIntervalMs: 5 }, runtime), /quarantined pending controlled recovery/u);
});

test("owner death with a live owned target stays blocked until explicit cleanup proof", async (t) => {
  const runtime = await testRuntime(t);
  const config = { runtime, scope: scope(44), spawnTarget: true };
  const owner = GateChild.start(config);
  t.after(async () => owner.terminate());
  assert.deepEqual(await owner.next(), { type: "waiting" });
  const acquired = await owner.next() as { type: string; id: string; targetPid: number };
  assert.equal(acquired.type, "acquired");
  const targetPid = acquired.targetPid;
  t.after(() => { try { process.kill(targetPid); } catch { /* already stopped */ } });
  owner.send("crash");
  assert.equal(await owner.waitForExit(), 1);
  assert.doesNotThrow(() => process.kill(targetPid, 0));
  await assert.rejects(acquireWindowsExecutionGuiGateForTest({ ...scope(44), timeoutMs: 500,
    retryIntervalMs: 5 }, runtime), /quarantined pending controlled recovery/u);
  process.kill(targetPid);
  await waitUntilAbsent(targetPid);
  const quarantine = await observeWindowsExecutionGuiGateQuarantineForTest(scope(44), runtime);
  assert.ok(quarantine);
  await recoverWindowsExecutionGuiGateQuarantineForTest({ ...scope(44), timeoutMs: 500 }, {
    quarantine, status: "ownedResourcesCleanupConfirmed", proofId: randomUUID(),
    observedAt: new Date().toISOString(),
  }, runtime);
  const successor = await acquireWindowsExecutionGuiGateForTest(scope(44), runtime);
  assert.equal((await successor.release()).status, "released");
});

test("stale cleanup proof cannot recover a later quarantine generation", async (t) => {
  const runtime = await testRuntime(t);
  const configured = scope(45);
  const first = await acquireWindowsExecutionGuiGateForTest(configured, runtime);
  await first.quarantine("first injected quarantine");
  const generationOne = await observeWindowsExecutionGuiGateQuarantineForTest(configured, runtime);
  assert.ok(generationOne);
  const proofA = cleanupProof(generationOne);
  const proofB = cleanupProof(generationOne);
  await recoverWindowsExecutionGuiGateQuarantineForTest(configured, proofA, runtime);

  const owner = GateChild.start({ runtime, scope: configured, spawnTarget: true });
  t.after(async () => owner.terminate());
  assert.deepEqual(await owner.next(), { type: "waiting" });
  const acquired = await owner.next() as { type: string; targetPid: number };
  assert.equal(acquired.type, "acquired");
  const targetPid = acquired.targetPid;
  t.after(() => { try { process.kill(targetPid); } catch { /* already stopped */ } });
  const generationTwo = await observeWindowsExecutionGuiGateQuarantineForTest(configured, runtime);
  assert.ok(generationTwo);
  assert.notEqual(generationTwo.leaseToken, generationOne.leaseToken);
  owner.send("quarantine");
  assert.deepEqual(await owner.next(), { type: "quarantined" });
  assert.equal(await owner.waitForExit(), 1);
  assert.doesNotThrow(() => process.kill(targetPid, 0));

  await assert.rejects(recoverWindowsExecutionGuiGateQuarantineForTest(configured, proofB, runtime),
    /generation changed.*stale/u);
  await assert.rejects(acquireWindowsExecutionGuiGateForTest({ ...configured, timeoutMs: 300,
    retryIntervalMs: 5 }, runtime), /quarantined pending controlled recovery/u);
  await assert.rejects(recoverWindowsExecutionGuiGateQuarantineForTest(configured, {
    ...cleanupProof(generationTwo),
    observedAt: new Date(Date.parse(generationTwo.createdAt) - 1).toISOString(),
  }, runtime), /predates the quarantine generation/u);

  process.kill(targetPid);
  await waitUntilAbsent(targetPid);
  await recoverWindowsExecutionGuiGateQuarantineForTest(configured, cleanupProof(generationTwo), runtime);
  const successor = await acquireWindowsExecutionGuiGateForTest(configured, runtime);
  assert.equal((await successor.release()).status, "released");
});

test("snapshot and path preflight failures safely release before GUI acquisition", async (t) => {
  const root = await temporary(t);
  const events: string[] = [];
  const gate = recordedGate(events);
  const definition = caseDefinition("preflight", events, false);
  const configured = options(root, definition, gate, events, false, false);
  await mkdir(configured.stagingDirectory, { recursive: true });
  await assert.rejects(runCaseV3(definition, configured), /already exists/u);
  assert.deepEqual(events, ["GATE_RELEASED"]);

  const invalidEvents: string[] = [];
  const invalid = { ...options(path.join(root, "invalid"), definition, recordedGate(invalidEvents),
    invalidEvents, false, false), unexpected: true } as unknown as RunCaseV3Options;
  await assert.rejects(runCaseV3(definition, invalid), /unknown metadata/u);
  assert.deepEqual(invalidEvents, ["GATE_RELEASED"]);

  const noAcquisitionEvents: string[] = [];
  const noAcquisition = caseDefinition("fixture-setup-failed", noAcquisitionEvents, false, true);
  await assert.rejects(runCaseV3(noAcquisition, options(path.join(root, "no-acquisition"),
    noAcquisition, recordedGate(noAcquisitionEvents), noAcquisitionEvents, false, false)),
  /No v3 surface was actually acquired/u);
  assert.deepEqual(noAcquisitionEvents, ["GATE_RELEASED"]);
});

test("an acquisition that started but did not return is conservatively quarantined", async (t) => {
  const root = await temporary(t);
  const events: string[] = [];
  const definition = caseDefinition("acquisition-unknown", events, false);
  const configured = options(root, definition, recordedGate(events), events, false, false);
  const native = configured.surfaces[0]!;
  if (native.kind !== "native") throw new Error("Expected native surface.");
  const uncertain: RunCaseV3Options = { ...configured, surfaces: [{ ...native, backend: {
    ...native.backend, prepare: () => ({ acquire: async (call) => {
      call.beforeSubmit(); throw new Error("acquisition receipt lost");
    } }),
  } }] };
  await assert.rejects(runCaseV3(definition, uncertain), /No v3 surface was actually acquired/u);
  assert.deepEqual(events, ["fixture", "GATE_QUARANTINED"]);
});

function caseDefinition(suffix: string, events: string[], failFixture: boolean, failSetup = false) {
  const fixture = defineFixture({ id: `execution.gate.fixture.${suffix}`, setup: () => {
    if (failSetup) throw new Error("fixture setup failed");
    return { value: true,
      teardown: () => { events.push("fixture"); if (failFixture) throw new Error("fixture teardown failed"); } };
  } });
  const spec = { id: `execution.gate.${suffix}`, locale: "zh-CN",
    platforms: suffix === "mixed" ? ["windows", "web"] as const : ["windows"] as const,
    suite: { id: "execution.gate", name: "图形执行门禁" }, name: "共享交互会话门禁",
    intent: "验证 GUI execution 门禁仅在最终清理证明后释放。", preconditions: [],
    acceptanceCriteria: [{ id: "ran", text: "Case 主体已执行。" }], sideEffect: "writesLocal" as const };
  return defineCaseV3({ spec, fixtures: [fixture], run: async (context: CaseContextV3) => {
    await context.criterion("ran", () => undefined);
  } });
}

function recordedGate(events: string[]): ExecutionGuiGate {
  return { id: `test.gate.${randomUUID()}`, release: () => {
    events.push("GATE_RELEASED"); return { status: "released" };
  }, quarantine: () => { events.push("GATE_QUARANTINED"); } };
}

function scope(sessionId: number) { return { userSid: sid, sessionId, desktop: "default" } as const }

function options(root: string, definition: ReturnType<typeof caseDefinition>, executionGate: ExecutionGuiGate,
  events: string[], failNative: boolean, mixed: boolean): RunCaseV3Options {
  const plan = defineExecutionPlan({ spec: definition.spec, requirements: { host: { os: ["windows"] },
    surfaces: { desktop: { kind: "desktop", capabilities: ["ui.inspect"] }, ...(mixed ? {
      page: { kind: "browser" as const, capabilities: ["browser.dom.inspect"] },
    } : {}) } }, effects: mixed ? [{ resource: "browser.session", operation: "execute",
      boundary: "local", securitySensitive: false, recovery: "unknown" }] : [] });
  return { platform: "windows", runnerHostId: "runner", executionGate,
    run: { id: `gate-${randomUUID()}`, title: "GUI gate contract", app: { id: "fixture", name: "Fixture" },
      hosts: [{ id: "runner", os: "windows" }, { id: "native-host", os: "windows" },
        ...(mixed ? [{ id: "browser-host", os: "windows" as const }] : [])] },
    surfaces: [{ kind: "native", backend: nativeBackend(events, failNative), requirement: {
      kind: "native", surfaceId: "desktop", expectedHostId: "native-host", platform: "windows",
      backend: "uia", acquisition: "launch", capabilities: ["ui.inspect"], target: "fixture",
    } }, ...(mixed ? [browserSurface(events)] : [])],
    execution: { plan, environment: { platform: "windows", host: { os: "windows" }, surfaces: {
      desktop: { kind: "desktop", capabilities: ["ui.inspect"] }, ...(mixed ? {
        page: { kind: "browser" as const, capabilities: ["browser.dom.inspect"] },
      } : {}) } }, policy: { maximumSideEffect: "writesLocal", grants: mixed ? [{
      resource: "browser.session", operations: ["execute"], boundaries: ["local"],
      allowUnknownRecovery: true,
    }] : [] }, timeoutMs: 2_000, cleanupTimeoutMs: 100 },
    stagingDirectory: path.join(root, `staging-${randomUUID()}`),
    outputDirectory: path.join(root, `report-${randomUUID()}`) };
}

function browserSurface(events: string[]): RunCaseV3Options["surfaces"][number] {
  return { kind: "browser", backend: { hostId: "browser-host", capabilities: ["browser.dom.inspect"],
    launch: async (_requirement, call) => { call.beforeSubmit(); return {
      identity: { hostId: "browser-host", sessionId: "browser-session" }, invoke: async () => null,
      close: async () => { events.push("browser"); return { kind: "browserSessionClosed" as const,
        hostId: "browser-host", sessionId: "browser-session" }; },
    }; } }, requirement: { kind: "browser", surfaceId: "page", expectedHostId: "browser-host",
      capabilities: ["browser.dom.inspect"], engine: "chromium" } };
}

function nativeBackend(events: string[], fail: boolean): NativeSurfaceBackendPort<"windows"> {
  return { hostId: "native-host", platform: "windows", backend: "uia", capabilities: ["ui.inspect"],
    prepare: (_requirement, context) => {
      context.registerResource({ id: "fake.native.host", ownership: "owned", cleanup: () => {
        events.push("native-host"); return fail ? { status: "unconfirmed", reason: "injected" }
          : { status: "released" };
      } });
      context.registerResource({ id: "fake.native.session", ownership: "owned", cleanup: () => {
        events.push("native-session"); return { status: "released" };
      } });
      return { acquire: async (call) => { call.beforeSubmit(); return { ownership: "owned",
        platform: "windows", backend: "uia", capabilities: ["ui.inspect"], invoke: async () => null }; } };
    } };
}

async function testRuntime(context: TestContext): Promise<WindowsExecutionGuiGateTestRuntime> {
  return { platform: "win32", localAppData: await temporary(context) };
}

async function temporary(context: TestContext): Promise<string> {
  const root = path.resolve(await mkdtemp(path.join(os.tmpdir(), "surfaceloom-execution-gate-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function waitUntilAbsent(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Owned target did not exit.");
}

function cleanupProof(quarantine: NonNullable<Awaited<ReturnType<
  typeof observeWindowsExecutionGuiGateQuarantineForTest>>>) {
  return { quarantine, status: "ownedResourcesCleanupConfirmed" as const, proofId: randomUUID(),
    observedAt: new Date(Math.max(Date.now(), Date.parse(quarantine.createdAt))).toISOString() };
}
