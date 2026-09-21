import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  AgentTestService, createSurfaceLoomMcpHandler, FileArtifactStore, FileRunStore,
  listenSurfaceLoomMcp, LocalGitWorkspaceProvider, PersistentRunService, TestCatalog,
} from "@surfaceloom/service";

import {
  assertPackedResolution, cancelTestId, cliTestId, createRepository, definitions,
  RecordingProvider, RoutingExecutor, uncleanTestId, v3CaseId, v3TestId,
} from "./contract-fixture.mjs";

test("packed consumer completes MCP, CLI, v3, cancellation, and quarantine flows", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-consumer-flow-"));
  t.after(async () => { await makeWritable(root); await rm(root, { recursive: true, force: true }); });
  await assertPackedResolution(process.env.SURFACELOOM_CONSUMER_ROOT,
    process.env.SURFACELOOM_REPOSITORY_ROOT);
  const repository = await createRepository(root);
  const provider = new RecordingProvider(new LocalGitWorkspaceProvider({
    sourceRoot: repository.sourceRoot, snapshotRoot: repository.snapshotRoot,
  }));
  const artifactStore = await FileArtifactStore.open(path.join(root, "artifacts"));
  const executor = new RoutingExecutor({ artifactStore, counterPath: path.join(root, "executions.log"),
    workRoot: path.join(root, "v3-work") });
  const persistent = await PersistentRunService.create({
    runStore: await FileRunStore.open(path.join(root, "runs")), artifactStore, executor,
    workspaceLifecycle: provider, cancelTimeoutMs: 1_000,
  });
  const catalog = new TestCatalog(definitions());
  const service = new AgentTestService({ catalog, runs: persistent, workspaceProvider: provider,
    workspaceSources: { repository: { provider: "local-git", locator: "repository" } } });
  const endpoint = await listenSurfaceLoomMcp(createSurfaceLoomMcpHandler(service));
  t.after(() => endpoint.close());

  let client = await connect(endpoint.url);
  t.after(() => client.close().catch(() => undefined));
  assert.equal(data(await client.callTool({ name: "catalog", arguments: {} })).tests.length, 4);

  const cliSnapshot = await prepare(client, repository.revision);
  const cliRequest = { requestId: "packed-response-loss", snapshotId: cliSnapshot,
    testId: cliTestId, parameters: {} };
  await assert.rejects(async () => {
    await service.start(cliRequest);
    throw new Error("Injected transport response loss after dispatch.");
  }, /response loss/);
  await client.close();
  client = await connect(endpoint.url);
  const recovered = await poll(client, "status", { kind: "request", requestId: cliRequest.requestId },
    value => value.run !== undefined && terminal(value.run.status));
  assert.equal(recovered.run.status, "completed", JSON.stringify(recovered.run));
  const replay = data(await client.callTool({ name: "run", arguments: cliRequest }));
  assert.equal(replay.runId, recovered.run.runId);
  assert.equal(replay.reused, true);
  assert.equal(executor.counts.get(cliTestId), 1);
  assert.equal((await readFile(path.join(root, "executions.log"), "utf8")).trim(), "once");

  const v3Snapshot = await prepare(client, repository.revision);
  const v3 = data(await client.callTool({ name: "run", arguments: {
    requestId: "packed-v3", snapshotId: v3Snapshot, testId: v3TestId, parameters: {},
  } }));
  await client.close();
  client = await connect(endpoint.url);
  const v3Result = await poll(client, "get_result", { runId: v3.runId }, value => value.ready);
  assert.equal(v3Result.run.status, "completed");
  assert.equal(v3Result.run.outcome, "passed");
  assert.equal(v3Result.run.executionLinks.caseSpecs[0].caseSpecId, v3CaseId);
  const report = v3Result.run.artifacts.find((item) => item.name === "report.json");
  assert.ok(report);
  const reportChunk = data(await client.callTool({ name: "get_artifact",
    arguments: { artifactId: report.artifactId } }));
  assert.equal(JSON.parse(Buffer.from(reportChunk.dataBase64, "base64")).run.id, v3.runId);

  const cancelSnapshot = await prepare(client, repository.revision);
  const cancellable = data(await client.callTool({ name: "run", arguments: {
    requestId: "packed-cancel", snapshotId: cancelSnapshot, testId: cancelTestId, parameters: {},
  } }));
  await poll(client, "status", { kind: "run", runId: cancellable.runId },
    value => value.run?.status === "running");
  assert.equal(data(await client.callTool({ name: "cancel", arguments: {
    runId: cancellable.runId, reason: "packed consumer cancellation",
  } })).disposition, "accepted");
  const cancelled = await poll(client, "get_result", { runId: cancellable.runId },
    value => value.ready);
  assert.equal(cancelled.run.status, "cancelled");
  assert.equal(cancelled.run.tainted, false);

  const uncleanSnapshotId = await prepare(client, repository.revision);
  const unclean = data(await client.callTool({ name: "run", arguments: {
    requestId: "packed-unclean", snapshotId: uncleanSnapshotId,
    testId: uncleanTestId, parameters: {},
  } }));
  const uncleanResult = await poll(client, "get_result", { runId: unclean.runId },
    value => value.ready);
  assert.equal(uncleanResult.run.status, "failed");
  assert.equal(uncleanResult.run.tainted, true);
  assert.equal(uncleanResult.run.cleanup.status, "unconfirmed");
  const snapshot = provider.snapshots.get(uncleanSnapshotId);
  assert.ok(snapshot);
  const before = executor.counts.get(uncleanTestId);
  const blocked = await persistent.start({ requestId: "packed-unclean-reuse",
    snapshot: { snapshotId: snapshot.snapshotId, resolvedRevision: snapshot.resolvedRevision },
    testId: uncleanTestId, parameters: {}, definition: catalog.require(uncleanTestId),
    workspace: snapshot });
  const blockedResult = await persistent.wait(blocked.runId);
  assert.equal(blockedResult.status, "interrupted");
  assert.equal(blockedResult.tainted, true);
  assert.equal(executor.counts.get(uncleanTestId), before);
  await client.close();
});

async function connect(url) {
  const client = new Client({ name: "surfaceloom-packed-consumer", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

async function prepare(client, revision) {
  const started = data(await client.callTool({ name: "prepare",
    arguments: { sourceKey: "repository", revision } }));
  const ready = await poll(client, "status", { kind: "operation", operationId: started.operationId },
    value => value.operation?.status === "ready");
  return ready.operation.snapshotId;
}

async function poll(client, name, args, ready) {
  const deadline = Date.now() + 8_000;
  let value;
  while (true) {
    value = data(await client.callTool({ name, arguments: args }));
    if (ready(value)) return value;
    if (Date.now() >= deadline) {
      throw new Error(`${name} did not become ready: ${JSON.stringify(value)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function terminal(status) {
  return ["completed", "failed", "cancelled", "interrupted"].includes(status);
}

async function makeWritable(target) {
  let descriptor;
  try { descriptor = await lstat(target); } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (descriptor.isSymbolicLink()) return;
  await chmod(target, descriptor.isDirectory() ? 0o700 : 0o600);
  if (descriptor.isDirectory()) {
    for (const entry of await readdir(target)) await makeWritable(path.join(target, entry));
  }
}

function data(result) {
  assert.equal(typeof result.structuredContent, "object");
  return result.structuredContent;
}
