import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createOperationId, createRunId, FileArtifactStore, FileRunStore, PersistentRunService,
  SurfaceLoomV3Executor, validateTestDefinition, type ExecuteRequest,
} from "../../../src/index.js";
import {
  v3CaseId, v3Registration, v3ServiceDefinition,
} from "./helpers.js";

test("v3 service executor persists a complete Reporter bundle and releases safe work", async (t) => {
  const fixture = await serviceFixture(t);
  const started = await fixture.service.start(fixture.submission("v3-passed"));
  const record = await fixture.service.wait(started.runId);

  assert.equal(record?.status, "completed");
  assert.equal(record?.outcome, "passed");
  assert.equal(record?.cleanup?.status, "confirmed");
  assert.deepEqual(record?.artifacts.map((item) => item.name).filter((name) =>
    ["ai-review.md", "complete.json", "index.html", "report.json"].includes(name)),
  ["ai-review.md", "complete.json", "index.html", "report.json"]);
  const reportArtifact = record?.artifacts.find((item) => item.name === "report.json");
  assert.ok(reportArtifact);
  const report = JSON.parse(Buffer.from((await fixture.artifacts.get(
    reportArtifact.artifactId))!.data).toString()) as { run: { id: string }, status: string };
  assert.equal(report.run.id, started.runId);
  assert.equal(report.status, "passed");
  await assert.rejects(stat(path.join(fixture.workRoot, started.runId.slice(4))), { code: "ENOENT" });
});

test("a business assertion failure stays completed/failed instead of becoming infrastructure failure",
  async (t) => {
    const fixture = await serviceFixture(t, { failCase: true });
    const started = await fixture.service.start(fixture.submission("v3-business-failed"));
    const record = await fixture.service.wait(started.runId);

    assert.equal(record?.status, "completed");
    assert.equal(record?.outcome, "failed");
    assert.match(record?.result && "reason" in record.result ? record.result.reason : "",
      /Status was not ready/u);
    assert.equal(record?.cleanup?.status, "confirmed");
  });

test("a browser transport failure stays infrastructure failure instead of a business verdict",
  async (t) => {
    const fixture = await serviceFixture(t, { failInvoke: true });
    const started = await fixture.service.start(fixture.submission("v3-transport-failed"));
    const record = await fixture.service.wait(started.runId);

    assert.equal(record?.status, "failed");
    assert.equal(record?.outcome, null);
    assert.equal(record?.cleanup?.status, "confirmed");
    assert.match(record?.result && "error" in record.result ? record.result.error.message : "",
      /transport disconnected/u);
  });

test("unconfirmed kernel cleanup quarantines the run and retains its diagnostic work", async (t) => {
  const fixture = await serviceFixture(t, { failCleanup: true });
  const started = await fixture.service.start(fixture.submission("v3-cleanup-failed"));
  const record = await fixture.service.wait(started.runId);

  assert.equal(record?.status, "failed");
  assert.equal(record?.outcome, null);
  assert.equal(record?.cleanup?.status, "unconfirmed");
  assert.equal(record?.tainted, true);
  assert.equal((await stat(path.join(fixture.workRoot, started.runId.slice(4)))).isDirectory(), true);
});

test("service cancellation reaches a cancelled terminal result after cooperative kernel stop",
  async (t) => {
    let markStarted!: () => void;
    const caseStarted = new Promise<void>(resolve => { markStarted = resolve; });
    const fixture = await serviceFixture(t, { waitForCancellation: true,
      onRunStarted: markStarted });
    const started = await fixture.service.start(fixture.submission("v3-cancelled"));
    await caseStarted;
    assert.equal((await fixture.service.cancel(started.runId, "fixture cancellation")).disposition,
      "accepted");
    const record = await fixture.service.wait(started.runId);
    assert.equal(record?.status, "cancelled");
    assert.equal(record?.outcome, null);
    assert.equal(record?.cleanup?.status, "confirmed");
  });

test("an existing run directory is never deleted when exclusive creation fails", async (t) => {
  const fixture = await serviceFixture(t);
  const runId = createRunId();
  const runRoot = path.join(fixture.workRoot, runId.slice(4));
  const sentinel = path.join(runRoot, "owner-data.txt");
  await mkdir(runRoot, { recursive: true });
  await writeFile(sentinel, "not owned by the executor");
  const { requestId: _requestId, ...request } = fixture.submission("v3-existing-run-root");

  const result = await fixture.executor.execute({ ...request, runId }, new AbortController().signal);

  assert.equal(result.executionStatus, "failed");
  assert.equal(await readFile(sentinel, "utf8"), "not owned by the executor");
});

test("an unsafe workRoot symlink never deletes the immutable workspace", {
  skip: process.platform === "win32" ? "Windows symlink creation is not generally available." : false,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "surfaceloom-v3-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "immutable-workspace");
  const workRoot = path.join(root, "executor-work-link");
  const sentinel = path.join(workspaceRoot, "owner-data.txt");
  await mkdir(workspaceRoot);
  await writeFile(sentinel, "immutable workspace");
  await symlink(workspaceRoot, workRoot, "dir");
  const artifacts = await FileArtifactStore.open(path.join(root, "artifacts"));
  const runs = await FileRunStore.open(path.join(root, "runs"));
  const executor = new SurfaceLoomV3Executor("surfaceloom.v3", {
    registrations: [v3Registration()], workRoot, artifactStore: artifacts,
  });
  const service = await PersistentRunService.create({ runStore: runs,
    artifactStore: artifacts, executor });
  const definition = validateTestDefinition(v3ServiceDefinition());
  const started = await service.start({ requestId: "v3-unsafe-work-root",
    snapshot: { snapshotId: "snapshot:v3", resolvedRevision: "fixture-revision" },
    testId: definition.testId, parameters: {}, definition,
    executionLinks: { caseSpecs: [{ namespace: "case-spec", caseSpecId: v3CaseId }],
      agentRuns: [], nativeOperations: [] },
    workspace: { operationId: createOperationId(), snapshotId: "snapshot:v3",
      resolvedRevision: "fixture-revision", rootPath: workspaceRoot,
      runtimeMetadata: { provider: "fixture" }, autMetadata: { app: "fixture" } },
  });

  const record = await service.wait(started.runId);
  assert.equal(record?.status, "failed");
  assert.equal(await readFile(sentinel, "utf8"), "immutable workspace");
});

async function serviceFixture(t: test.TestContext,
  behavior: Parameters<typeof v3Registration>[0] = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "surfaceloom-v3-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifacts = await FileArtifactStore.open(path.join(root, "artifacts"));
  const runs = await FileRunStore.open(path.join(root, "runs"));
  const workRoot = path.join(root, "executor-work");
  const workspaceRoot = path.join(root, "immutable-workspace");
  await mkdir(workspaceRoot);
  const executor = new SurfaceLoomV3Executor("surfaceloom.v3", {
    registrations: [v3Registration(behavior)], workRoot, artifactStore: artifacts,
  });
  const service = await PersistentRunService.create({ runStore: runs,
    artifactStore: artifacts, executor });
  const definition = validateTestDefinition(v3ServiceDefinition());
  const submission = (requestId: string) => ({ requestId,
    snapshot: { snapshotId: "snapshot:v3", resolvedRevision: "fixture-revision" },
    testId: definition.testId, parameters: {}, definition,
    executionLinks: { caseSpecs: [{ namespace: "case-spec" as const, caseSpecId: v3CaseId }],
      agentRuns: [], nativeOperations: [] },
    workspace: { operationId: createOperationId(), snapshotId: "snapshot:v3",
      resolvedRevision: "fixture-revision", rootPath: workspaceRoot,
      runtimeMetadata: { provider: "fixture" }, autMetadata: { app: "fixture" } },
  } satisfies Omit<ExecuteRequest, "runId"> & { requestId: string });
  return { artifacts, executor, service, submission, workRoot };
}
