import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  acquireWindowsExecutionGuiGateForTest,
  observeWindowsExecutionGuiGateQuarantineForTest,
  recoverWindowsExecutionGuiGateQuarantineForTest,
  type WindowsExecutionGuiGateTestRuntime,
} from "../src/execution-gate.js";
import { GateChild } from "./execution-gate-support.js";

const sid = "S-1-5-21-100-200-300-1001";

test("delayed recovery cannot rename a live later-generation marker", async (t) => {
  const baseRuntime = await testRuntime(t);
  const barrier = renameBarrier(baseRuntime);
  const configured = scope(46);
  const first = await acquireWindowsExecutionGuiGateForTest(configured, barrier.runtime);
  await first.quarantine("first generation awaits recovery");
  const generationOne = await observed(configured, barrier.runtime);
  const recoveryA = recoverWindowsExecutionGuiGateQuarantineForTest(configured,
    cleanupProof(generationOne), barrier.runtime);
  await barrier.entered;
  await recoverWindowsExecutionGuiGateQuarantineForTest(configured, cleanupProof(generationOne),
    barrier.runtime);

  const owner = GateChild.start({ runtime: baseRuntime, scope: configured, spawnTarget: true });
  t.after(async () => owner.terminate());
  assert.deepEqual(await owner.next(), { type: "waiting" });
  const acquired = await owner.next() as { type: string; targetPid: number };
  assert.equal(acquired.type, "acquired");
  const targetPid = acquired.targetPid;
  t.after(() => { try { process.kill(targetPid); } catch { /* already stopped */ } });
  const generationTwo = await observed(configured, baseRuntime);
  assert.notEqual(generationTwo.leaseToken, generationOne.leaseToken);
  const staleRetirement = assert.rejects(recoveryA, /ownership changed during retirement/u);
  barrier.resume();
  await staleRetirement;
  assert.deepEqual(await observed(configured, baseRuntime), generationTwo);

  owner.send("quarantine");
  assert.deepEqual(await owner.next(), { type: "quarantined" });
  assert.equal(await owner.waitForExit(), 1);
  assert.doesNotThrow(() => process.kill(targetPid, 0));
  await assert.rejects(acquireWindowsExecutionGuiGateForTest({ ...configured, timeoutMs: 300,
    retryIntervalMs: 5 }, baseRuntime), /quarantined pending controlled recovery/u);
  process.kill(targetPid);
  await waitUntilAbsent(targetPid);
  await recoverWindowsExecutionGuiGateQuarantineForTest(configured, cleanupProof(generationTwo), baseRuntime);
  const successor = await acquireWindowsExecutionGuiGateForTest(configured, baseRuntime);
  assert.equal((await successor.release()).status, "released");
});

test("delayed normal release is fenced from a later generation", async (t) => {
  const baseRuntime = await testRuntime(t);
  const barrier = renameBarrier(baseRuntime, false);
  const configured = scope(47);
  const first = await acquireWindowsExecutionGuiGateForTest(configured, barrier.runtime);
  const generationOne = await observed(configured, barrier.runtime);
  const delayedRelease = Promise.resolve(first.release());
  await barrier.entered;
  await recoverWindowsExecutionGuiGateQuarantineForTest(configured, cleanupProof(generationOne), baseRuntime);
  const second = await acquireWindowsExecutionGuiGateForTest(configured, baseRuntime);
  const generationTwo = await observed(configured, baseRuntime);
  const staleRetirement = assert.rejects(delayedRelease, /ownership changed during retirement/u);
  barrier.resume();
  await staleRetirement;
  assert.deepEqual(await observed(configured, baseRuntime), generationTwo);
  await second.quarantine("second generation remains fenced");
  await assert.rejects(acquireWindowsExecutionGuiGateForTest({ ...configured, timeoutMs: 300,
    retryIntervalMs: 5 }, baseRuntime), /quarantined pending controlled recovery/u);
  await recoverWindowsExecutionGuiGateQuarantineForTest(configured, cleanupProof(generationTwo), baseRuntime);
  const successor = await acquireWindowsExecutionGuiGateForTest(configured, baseRuntime);
  assert.equal((await successor.release()).status, "released");
});

function renameBarrier(base: WindowsExecutionGuiGateTestRuntime, onlyFirst = true) {
  let entered!: () => void;
  let resume!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  const resumePromise = new Promise<void>((resolve) => { resume = resolve; });
  let delayed = false;
  const runtime: WindowsExecutionGuiGateTestRuntime = { ...base, beforeRetireRename: async () => {
    if (onlyFirst && delayed) return;
    delayed = true; entered(); await resumePromise;
  } };
  return { runtime, entered: enteredPromise, resume };
}

async function observed(configured: ReturnType<typeof scope>, runtime: WindowsExecutionGuiGateTestRuntime) {
  const identity = await observeWindowsExecutionGuiGateQuarantineForTest(configured, runtime);
  assert.ok(identity);
  return identity;
}
function cleanupProof(quarantine: Awaited<ReturnType<typeof observed>>) {
  return { quarantine, status: "ownedResourcesCleanupConfirmed" as const, proofId: randomUUID(),
    observedAt: new Date(Math.max(Date.now(), Date.parse(quarantine.createdAt))).toISOString() };
}
function scope(sessionId: number) { return { userSid: sid, sessionId, desktop: "default" } as const; }
async function testRuntime(context: TestContext): Promise<WindowsExecutionGuiGateTestRuntime> {
  const localAppData = path.resolve(await mkdtemp(path.join(os.tmpdir(), "surfaceloom-gate-aba-")));
  context.after(() => rm(localAppData, { recursive: true, force: true }));
  return { platform: "win32", localAppData };
}
async function waitUntilAbsent(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Owned target did not exit.");
}
