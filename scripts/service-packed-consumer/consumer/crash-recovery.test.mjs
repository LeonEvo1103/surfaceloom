import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FileArtifactStore, FileRunStore, PersistentRunService } from "@surfaceloom/service";

import { crashRequestId, crashSubmission, DurableCrashLifecycle } from "./crash-support.mjs";

test("packed consumer recovers a crashed service without replaying its live child", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-consumer-crash-"));
  await mkdir(path.join(root, "workspace"));
  let worker;
  let childPid;
  try {
    worker = spawn(process.execPath, [path.resolve("crash-worker.mjs"), root], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const ready = await readJsonWhenReady(path.join(root, "worker-ready.json"));
    childPid = ready.childPid;
    assert.equal(processExists(childPid), true);
    worker.kill("SIGKILL");
    await waitForExit(worker);
    assert.equal(processExists(childPid), true, "fixture child should outlive the crashed service");

    let recoveryExecutions = 0;
    const executor = { id: "packed.crash", async execute() { recoveryExecutions += 1;
      throw new Error("Recovered execution must not run."); },
    async cancel(request) { return { runId: request.runId, disposition: "not-found" }; },
    async cleanup(request) { return { runId: request.runId, snapshotId: request.snapshot.snapshotId,
      status: "unconfirmed", tainted: true, attemptedAt: new Date().toISOString() }; } };
    const service = await PersistentRunService.create({
      runStore: await FileRunStore.open(path.join(root, "runs")),
      artifactStore: await FileArtifactStore.open(path.join(root, "artifacts")), executor,
      workspaceLifecycle: new DurableCrashLifecycle(root),
    });
    const recovered = await service.get(ready.runId);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.tainted, true);
    assert.equal(recovered.cleanup.status, "unconfirmed");
    const replay = await service.start(crashSubmission(root, crashRequestId));
    assert.equal(replay.runId, ready.runId);
    assert.equal(replay.reused, true);
    assert.equal(recoveryExecutions, 0);

    const blocked = await service.start(crashSubmission(root, "packed-crash-new-request"));
    const blockedResult = await service.wait(blocked.runId);
    assert.equal(blockedResult.status, "interrupted");
    assert.equal(blockedResult.tainted, true);
    assert.equal(recoveryExecutions, 0);
    assert.equal((await readFile(path.join(root, "execution.log"), "utf8")).trim().split("\n").length, 1);
  } finally {
    if (worker !== undefined && worker.exitCode === null && worker.signalCode === null) {
      worker.kill("SIGKILL");
      await waitForExit(worker).catch(() => undefined);
    }
    if (childPid !== undefined && processExists(childPid)) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
      await waitUntil(() => !processExists(childPid));
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function readJsonWhenReady(file) {
  let value;
  await waitUntil(async () => {
    try { value = JSON.parse(await readFile(file, "utf8")); return true; } catch { return false; }
  });
  return value;
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 8_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Condition did not become ready.");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose();
      reject(new Error("Child process did not exit before the conformance deadline."));
    }, 5_000);
    const exited = () => { dispose(); resolve(); };
    const failed = (error) => { dispose(); reject(error); };
    const dispose = () => {
      clearTimeout(timer);
      child.removeListener("exit", exited);
      child.removeListener("error", failed);
    };
    child.once("exit", exited);
    child.once("error", failed);
  });
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
