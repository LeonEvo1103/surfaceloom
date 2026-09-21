import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
  AgentTestService, createSurfaceLoomMcpHandler, FileArtifactStore, FileRunStore,
  listenSurfaceLoomMcp, PersistentRunService, TestCatalog,
  type ExecuteRequest, type Executor, type RunResult,
} from "../../src/index.js";
import { validDefinition } from "../fixtures.js";
import { FixtureWorkspaceProvider } from "./fixtures.js";

test("official MCP client survives reconnect and reads a completed run artifact", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runStore = await FileRunStore.open(path.join(root, "runs"));
  const artifactStore = await FileArtifactStore.open(path.join(root, "artifacts"));
  const provider = new FixtureWorkspaceProvider(root);
  let persistent!: PersistentRunService;
  let executions = 0;
  const executor: Executor = artifactExecutor(async (request) => {
    executions += 1;
    await new Promise(resolve => setTimeout(resolve, 25));
    const record = await persistent.putArtifact({ runId: request.runId, name: "report.json",
      mediaType: "application/json", data: Buffer.from('{"passed":true}') });
    return record.artifacts;
  });
  persistent = await PersistentRunService.create({ runStore, artifactStore, executor,
    workspaceLifecycle: provider });
  const service = new AgentTestService({ catalog: new TestCatalog([validDefinition()]),
    runs: persistent, workspaceProvider: provider,
    workspaceSources: { fixture: { provider: "fixture", locator: "repo" } } });
  const http = await listenSurfaceLoomMcp(createSurfaceLoomMcpHandler(service));
  t.after(() => http.close());

  const first = await connect(http.url);
  const catalog = await first.callTool({ name: "catalog", arguments: {} });
  assert.equal(data(catalog).tests.length, 1);
  const prepared = data(await first.callTool({ name: "prepare",
    arguments: { sourceKey: "fixture", revision: "abc123" } }));
  const operation = await pollTool(first, "status", { kind: "operation",
    operationId: prepared.operationId }, value => value.operation?.status === "ready");
  const started = data(await first.callTool({ name: "run", arguments: {
    requestId: "mcp-reconnect", snapshotId: operation.operation.snapshotId,
    testId: "service-test:reference/smoke", parameters: { locale: "zh-CN" },
  } }));
  await first.close();

  const second = await connect(http.url);
  t.after(() => second.close());
  const recovered = data(await second.callTool({ name: "status", arguments: {
    kind: "request", requestId: "mcp-reconnect",
  } }));
  assert.equal(recovered.run.runId, started.runId);
  const result = await pollTool(second, "get_result", { runId: started.runId },
    value => value.ready === true);
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.outcome, "passed");
  const artifactId = result.run.artifacts[0].artifactId;
  const chunk = data(await second.callTool({ name: "get_artifact",
    arguments: { artifactId, limit: 4 } }));
  assert.equal(chunk.found, true);
  assert.equal(Buffer.from(chunk.dataBase64, "base64").toString(), '{"pa');
  assert.equal(typeof chunk.nextOffset, "number");
  const retried = data(await second.callTool({ name: "run", arguments: {
    requestId: "mcp-reconnect", snapshotId: operation.operation.snapshotId,
    testId: "service-test:reference/smoke", parameters: { locale: "zh-CN" },
  } }));
  assert.equal(retried.runId, started.runId);
  assert.equal(retried.reused, true);
  assert.equal(executions, 1);
});

async function connect(url: URL): Promise<Client> {
  const client = new Client({ name: "surfaceloom-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

async function pollTool(client: Client, name: string, args: Record<string, unknown>,
  ready: (value: any) => boolean): Promise<any> {
  const deadline = Date.now() + 2_000;
  while (true) {
    const value = data(await client.callTool({ name, arguments: args }));
    if (ready(value)) return value;
    if (Date.now() >= deadline) throw new Error(`${name} did not become ready.`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function data(result: { structuredContent?: unknown }): any {
  assert.equal(typeof result.structuredContent, "object");
  return result.structuredContent;
}

function artifactExecutor(
  artifacts: (request: ExecuteRequest) => Promise<RunResult["artifacts"]>,
): Executor {
  return { id: "registered.node", async execute(request) {
    const startedAt = new Date().toISOString();
    return { runId: request.runId, snapshot: request.snapshot, testId: request.testId,
      parameters: request.parameters, startedAt, finishedAt: new Date().toISOString(),
      artifacts: await artifacts(request), cleanup: { runId: request.runId,
        snapshotId: request.snapshot.snapshotId, status: "confirmed", tainted: false,
        attemptedAt: new Date().toISOString() }, executionStatus: "completed", outcome: "passed" };
  }, async cancel(request) { return { runId: request.runId, disposition: "already-terminal" }; },
  async cleanup(request) { return { runId: request.runId, snapshotId: request.snapshot.snapshotId,
    status: "confirmed", tainted: false, attemptedAt: new Date().toISOString() }; } };
}
