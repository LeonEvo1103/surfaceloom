import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AgentTestService, FileArtifactStore, FileRunStore, PersistentRunService, TestCatalog,
  type ExecuteRequest, type Executor, type RunResult,
} from "../src/index.js";
import { validDefinition } from "./fixtures.js";
import { FixtureWorkspaceProvider } from "./mcp/fixtures.js";

test("requestId recovery after facade restart does not require an in-memory snapshot", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-agent-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, "runs");
  const artifactsRoot = path.join(root, "artifacts");
  const executor = immediateExecutor();
  const provider = new FixtureWorkspaceProvider(root);
  const firstRuns = await FileRunStore.open(runsRoot);
  const first = await PersistentRunService.create({ runStore: firstRuns,
    artifactStore: await FileArtifactStore.open(artifactsRoot), executor,
    workspaceLifecycle: provider });
  const facade = new AgentTestService({ catalog: new TestCatalog([validDefinition()]), runs: first,
    workspaceProvider: provider, workspaceSources: { fixture: { provider: "fixture", locator: "repo" } } });
  const prepared = facade.prepare("fixture", "abc123");
  await waitFor(() => facade.operation(prepared.operationId)?.status === "ready");
  const snapshotId = facade.operation(prepared.operationId)!.snapshotId!;
  const request = { requestId: "lost-response", snapshotId,
    testId: "service-test:reference/smoke", parameters: { locale: "zh-CN" } };
  const started = await facade.start(request);
  assert.equal((await first.wait(started.runId))?.status, "completed");
  await first.close();

  const restartedRuns = await FileRunStore.open(runsRoot);
  const restarted = await PersistentRunService.create({ runStore: restartedRuns,
    artifactStore: await FileArtifactStore.open(artifactsRoot), executor,
    workspaceLifecycle: new FixtureWorkspaceProvider(root) });
  const restartedFacade = new AgentTestService({ catalog: new TestCatalog([validDefinition()]),
    runs: restarted, workspaceProvider: new FixtureWorkspaceProvider(root),
    workspaceSources: { fixture: { provider: "fixture", locator: "repo" } } });
  const recovered = await restartedFacade.start(request);
  assert.equal(recovered.runId, started.runId);
  assert.equal(recovered.reused, true);
  await assert.rejects(restartedFacade.start({ ...request, snapshotId: "snapshot:other" }),
    /different run request/u);
});

function immediateExecutor(): Executor {
  return { id: "registered.node", async execute(request) { return passed(request); },
    async cancel(request) { return { runId: request.runId, disposition: "already-terminal" }; },
    async cleanup(request) { return { runId: request.runId, snapshotId: request.snapshot.snapshotId,
      status: "confirmed", tainted: false, attemptedAt: new Date().toISOString() }; } };
}

function passed(request: ExecuteRequest): RunResult {
  return { runId: request.runId, snapshot: request.snapshot, testId: request.testId,
    parameters: request.parameters, startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), artifacts: [],
    cleanup: { runId: request.runId, snapshotId: request.snapshot.snapshotId,
      status: "confirmed", tainted: false, attemptedAt: new Date().toISOString() },
    executionStatus: "completed", outcome: "passed" };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not reached.");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
