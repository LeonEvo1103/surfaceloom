import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
  AgentTestService, createSurfaceLoomMcpHandler, FileArtifactStore, FileRunStore,
  listenSurfaceLoomMcp, PersistentRunService, SurfaceLoomV3Executor, TestCatalog,
} from "../../src/index.js";
import {
  v3CaseId, v3Registration, v3ServiceDefinition, v3TestId,
} from "../executors/surfaceloom-v3/helpers.js";
import { FixtureWorkspaceProvider } from "./fixtures.js";

test("MCP runs the registered v3 kernel and returns its Reporter bundle", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-mcp-v3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactStore = await FileArtifactStore.open(path.join(root, "artifacts"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const provider = new FixtureWorkspaceProvider(workspaceRoot);
  const executor = new SurfaceLoomV3Executor("surfaceloom.v3", {
    registrations: [v3Registration()], workRoot: path.join(root, "executor-work"), artifactStore,
  });
  const persistent = await PersistentRunService.create({
    runStore: await FileRunStore.open(path.join(root, "runs")), artifactStore, executor,
    workspaceLifecycle: provider,
  });
  const service = new AgentTestService({ catalog: new TestCatalog([v3ServiceDefinition()]),
    runs: persistent, workspaceProvider: provider,
    workspaceSources: { fixture: { provider: "fixture", locator: "repository" } } });
  const http = await listenSurfaceLoomMcp(createSurfaceLoomMcpHandler(service));
  t.after(() => http.close());
  const client = new Client({ name: "surfaceloom-v3-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(http.url));
  t.after(() => client.close());

  const prepared = data(await client.callTool({ name: "prepare",
    arguments: { sourceKey: "fixture", revision: "v3-revision" } }));
  const operation = await poll(client, "status", { kind: "operation",
    operationId: prepared.operationId }, value => value.operation?.status === "ready");
  const started = data(await client.callTool({ name: "run", arguments: {
    requestId: "mcp-v3", snapshotId: operation.operation.snapshotId,
    testId: v3TestId, parameters: {},
  } }));
  const result = await poll(client, "get_result", { runId: started.runId },
    value => value.ready === true);

  assert.equal(result.run.status, "completed");
  assert.equal(result.run.outcome, "passed");
  assert.equal(result.run.cleanup.status, "confirmed");
  assert.equal(result.run.workspaceRelease.status, "confirmed");
  assert.equal(result.run.executionLinks.caseSpecs[0].caseSpecId, v3CaseId);
  const report = result.run.artifacts.find((item: { name: string }) => item.name === "report.json");
  assert.ok(report);
  const artifact = data(await client.callTool({ name: "get_artifact",
    arguments: { artifactId: report.artifactId } }));
  const reportJson = JSON.parse(Buffer.from(artifact.dataBase64, "base64").toString());
  assert.equal(reportJson.run.id, started.runId);
  assert.equal(reportJson.status, "passed");
});

async function poll(client: Client, name: string, args: Record<string, unknown>,
  ready: (value: any) => boolean): Promise<any> {
  const deadline = Date.now() + 3_000;
  while (true) {
    const value = data(await client.callTool({ name, arguments: args }));
    if (ready(value)) return value;
    if (Date.now() >= deadline) throw new Error(`${name} did not become ready.`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function data(result: { structuredContent?: unknown }): any {
  assert.equal(typeof result.structuredContent, "object");
  return result.structuredContent;
}
