import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createOperationId, createRunId, FileArtifactStore, FileRunStore, parseTestId, PersistentRunService,
  validateTestDefinition, type ExecuteRequest, type Executor, type RunResult,
} from "../src/index.js";
import { validDefinition } from "./fixtures.js";

test("dispatch sees a persisted run and a lost response retry does not execute twice", async (t) => {
  const fixture = await stores(t);
  let executions = 0;
  let persistedBeforeDispatch = false;
  const executor: Executor = {
    id: "registered.node",
    async execute(request) {
      executions += 1;
      persistedBeforeDispatch = (await fixture.runs.get(request.runId))?.status === "running";
      return passed(request);
    },
    async cancel(request) { return { runId: request.runId, disposition: "already-terminal" }; },
    async cleanup(request) { return cleanup(request.runId, request.snapshot.snapshotId, "confirmed"); },
  };
  const service = await PersistentRunService.create({ ...fixture, executor });
  const request = submission("stable-request");
  const first = await service.start(request);
  const completed = await service.wait(first.runId);
  const retried = await service.start(request);

  assert.equal(persistedBeforeDispatch, true);
  assert.equal(completed?.status, "completed");
  assert.equal(retried.runId, first.runId);
  assert.equal(retried.reused, true);
  assert.equal(executions, 1);
});

test("service restart exposes an interrupted result instead of rerunning", async (t) => {
  const fixture = await stores(t);
  const runId = (await fixture.runs.reserve({ requestId: "restart-request", fingerprint: "a".repeat(64),
    proposedRunId: createRunId(),
    snapshot: { snapshotId: "snapshot-fixture", resolvedRevision: "abc123" },
    testId: parseTestId("service-test:reference/smoke"), parameters: { locale: "zh-CN" },
    createdAt: "2026-09-21T00:00:00.000Z" })).record.runId;
  await fixture.runs.markRunning(runId, "2026-09-21T00:00:01.000Z");
  const service = await PersistentRunService.create({ ...fixture, executor: neverExecutor(),
    now: () => new Date("2026-09-21T00:00:02.000Z") });
  const recovered = await service.get(runId);
  assert.equal(recovered?.status, "interrupted");
  assert.equal(recovered?.error?.code, "service_restarted");
  assert.equal(recovered?.cleanup?.tainted, true);
});

test("cancel reaches an interrupted terminal state when executor cleanup never settles", async (t) => {
  const fixture = await stores(t);
  const service = await PersistentRunService.create({ ...fixture, executor: neverExecutor(),
    cancelTimeoutMs: 20 });
  const started = await service.start(submission("cancel-request"));
  await waitFor(async () => (await service.get(started.runId))?.status === "running");
  assert.equal((await service.cancel(started.runId, "test cancel")).disposition, "accepted");
  const result = await service.get(started.runId);
  assert.equal(result?.status, "interrupted");
  assert.equal(result?.error?.code, "cancel_cleanup_timeout");
  assert.equal(result?.tainted, true);
});

test("service attaches and reads immutable artifact bytes by run", async (t) => {
  const fixture = await stores(t);
  const service = await PersistentRunService.create({ ...fixture, executor: neverExecutor() });
  const started = await service.start(submission("artifact-request"));
  await waitFor(async () => (await service.get(started.runId))?.status === "running");
  const record = await service.putArtifact({ runId: started.runId, name: "screen.png",
    mediaType: "image/png", data: Buffer.from("image") });
  const artifact = record.artifacts[0]!;
  assert.equal(Buffer.from((await service.getArtifact(artifact.artifactId))!.data).toString(), "image");
});

function submission(requestId: string) {
  const definition = validateTestDefinition(validDefinition());
  return { requestId, snapshot: { snapshotId: "snapshot-fixture", resolvedRevision: "abc123" },
    testId: definition.testId, parameters: { locale: "zh-CN", retries: 0 }, definition,
    workspace: { operationId: createOperationId(), snapshotId: "snapshot-fixture",
      resolvedRevision: "abc123", rootPath: path.resolve("fixture-workspace"),
      runtimeMetadata: { provider: "fixture" }, autMetadata: { app: "fixture" } } };
}

function passed(request: ExecuteRequest): RunResult {
  return { runId: request.runId, snapshot: request.snapshot, testId: request.testId,
    parameters: request.parameters, startedAt: "2026-09-21T00:00:01.000Z",
    finishedAt: "2026-09-21T00:00:02.000Z", artifacts: [],
    cleanup: cleanup(request.runId, request.snapshot.snapshotId, "confirmed"),
    executionStatus: "completed", outcome: "passed" };
}

function cleanup(runId: ExecuteRequest["runId"], snapshotId: string,
  status: "confirmed" | "unconfirmed") {
  return { runId, snapshotId, status, tainted: status === "unconfirmed",
    attemptedAt: "2026-09-21T00:00:02.000Z" } as const;
}

function neverExecutor(): Executor {
  return { id: "registered.node", execute: async () => new Promise<RunResult>(() => undefined),
    cancel: async () => new Promise(() => undefined),
    async cleanup(request) { return cleanup(request.runId, request.snapshot.snapshotId, "unconfirmed"); } };
}

async function stores(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-service-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runs = await FileRunStore.open(path.join(root, "runs"));
  const artifacts = await FileArtifactStore.open(path.join(root, "artifacts"));
  return { runs, artifacts, runStore: runs, artifactStore: artifacts };
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Condition was not reached.");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
