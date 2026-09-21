import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createOperationId, FileArtifactStore, FileRunStore, PersistentRunService,
  validateTestDefinition, type CleanupReceipt, type ExecuteRequest, type Executor,
  type RunResult,
} from "../src/index.js";
import { validDefinition } from "./fixtures.js";

test("not-required cleanup still releases the workspace and remains successful", async (t) => {
  const fixture = await stores(t);
  let releases = 0;
  const lifecycle = lifecycleFixture(async (snapshot) => {
    releases += 1;
    return receipt(snapshot.snapshotId, "not-required");
  });
  const executor = immediateExecutor(request => ({ ...passed(request),
    cleanup: receipt(request.snapshot.snapshotId, "not-required", request.runId) }));
  const service = await PersistentRunService.create({ ...fixture, executor,
    workspaceLifecycle: lifecycle });

  const started = await service.start(submission("not-required-cleanup"));
  const result = await service.wait(started.runId);
  assert.equal(result?.status, "completed");
  assert.equal(result?.workspaceRelease?.status, "not-required");
  assert.equal(releases, 1);
});

test("concurrent cancellation is single-flight and uses a fresh workspace release signal", async (t) => {
  const fixture = await stores(t);
  let cancelCalls = 0;
  let releaseSignalWasAborted = true;
  const executor: Executor = {
    id: "registered.node",
    execute: async (request, signal) => new Promise<RunResult>((resolve) => {
      signal.addEventListener("abort", () => resolve(cancelled(request)), { once: true });
    }),
    async cancel(request) {
      cancelCalls += 1;
      return { runId: request.runId, disposition: "accepted" };
    },
    async cleanup(request) {
      return receipt(request.snapshot.snapshotId, "confirmed", request.runId);
    },
  };
  const lifecycle = lifecycleFixture(async (snapshot, signal) => {
    releaseSignalWasAborted = signal.aborted;
    return receipt(snapshot.snapshotId, "confirmed");
  });
  const service = await PersistentRunService.create({ ...fixture, executor,
    workspaceLifecycle: lifecycle, cancelTimeoutMs: 200 });
  const started = await service.start(submission("cancel-single-flight"));
  await waitFor(async () => (await service.get(started.runId))?.status === "running");

  const results = await Promise.all([
    service.cancel(started.runId, "stop"),
    service.cancel(started.runId, "stop again"),
  ]);
  assert.deepEqual(results.map(result => result.disposition), ["accepted", "accepted"]);
  assert.equal(cancelCalls, 1);
  assert.equal(releaseSignalWasAborted, false);
  const result = await service.wait(started.runId);
  assert.equal(result?.status, "cancelled");
  assert.equal(result?.workspaceRelease?.status, "confirmed");
  assert.equal(result?.tainted, false);
});

function lifecycleFixture(
  release: (snapshot: ExecuteRequest["workspace"], signal: AbortSignal) => Promise<CleanupReceipt>,
) {
  return {
    acquireLease(snapshot: ExecuteRequest["workspace"], runId: ExecuteRequest["runId"]) {
      return { snapshotId: snapshot.snapshotId, runId, generation: 1,
        acquiredAt: "2026-09-21T00:00:00.000Z" };
    },
    completeLease() {},
    release,
  };
}

function immediateExecutor(execute: (request: ExecuteRequest) => RunResult): Executor {
  return { id: "registered.node", async execute(request) { return execute(request); },
    async cancel(request) { return { runId: request.runId, disposition: "already-terminal" }; },
    async cleanup(request) { return receipt(request.snapshot.snapshotId, "confirmed", request.runId); } };
}

function submission(requestId: string) {
  const definition = validateTestDefinition(validDefinition());
  return { requestId, snapshot: { snapshotId: "snapshot-fixture", resolvedRevision: "abc123" },
    testId: definition.testId, parameters: { locale: "zh-CN" }, definition,
    workspace: { operationId: createOperationId(), snapshotId: "snapshot-fixture",
      resolvedRevision: "abc123", rootPath: path.resolve("fixture-workspace"),
      runtimeMetadata: { provider: "fixture" }, autMetadata: { app: "fixture" } } };
}

function passed(request: ExecuteRequest): RunResult {
  return { runId: request.runId, snapshot: request.snapshot, testId: request.testId,
    parameters: request.parameters, startedAt: "2026-09-21T00:00:01.000Z",
    finishedAt: "2026-09-21T00:00:02.000Z", artifacts: [],
    cleanup: receipt(request.snapshot.snapshotId, "confirmed", request.runId),
    executionStatus: "completed", outcome: "passed" };
}

function cancelled(request: ExecuteRequest): RunResult {
  return { ...passed(request), executionStatus: "cancelled", outcome: null,
    error: { code: "command_cancelled", message: "Cancelled by caller.", retryable: false } };
}

function receipt(snapshotId: string, status: CleanupReceipt["status"],
  runId?: ExecuteRequest["runId"]): CleanupReceipt {
  return { ...(runId === undefined ? {} : { runId }), snapshotId, status,
    tainted: status === "unconfirmed", attemptedAt: "2026-09-21T00:00:02.000Z" };
}

async function stores(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-service-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = await FileRunStore.open(path.join(root, "runs"));
  const artifacts = await FileArtifactStore.open(path.join(root, "artifacts"));
  return { runStore: runs, artifactStore: artifacts };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Condition was not reached.");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
