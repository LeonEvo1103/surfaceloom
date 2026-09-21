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

test("MCP cancel explicitly stops a run and preserves cancelled as the terminal state", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-mcp-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = new FixtureWorkspaceProvider(root);
  const persistent = await PersistentRunService.create({
    runStore: await FileRunStore.open(path.join(root, "runs")),
    artifactStore: await FileArtifactStore.open(path.join(root, "artifacts")),
    executor: cancellableExecutor(), workspaceLifecycle: provider,
  });
  const service = new AgentTestService({ catalog: new TestCatalog([validDefinition()]),
    runs: persistent, workspaceProvider: provider,
    workspaceSources: { fixture: { provider: "fixture", locator: "repo" } } });
  const http = await listenSurfaceLoomMcp(createSurfaceLoomMcpHandler(service));
  t.after(() => http.close());
  const client = new Client({ name: "surfaceloom-cancel-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(http.url));
  t.after(() => client.close());

  const prepared = data(await client.callTool({ name: "prepare",
    arguments: { sourceKey: "fixture", revision: "abc123" } }));
  const operation = await poll(client, "status", { kind: "operation",
    operationId: prepared.operationId }, value => value.operation?.status === "ready");
  const started = data(await client.callTool({ name: "run", arguments: {
    requestId: "cancel-via-mcp", snapshotId: operation.operation.snapshotId,
    testId: "service-test:reference/smoke", parameters: { locale: "zh-CN" },
  } }));
  const cancelled = data(await client.callTool({ name: "cancel",
    arguments: { runId: started.runId, reason: "caller requested stop" } }));
  assert.equal(cancelled.disposition, "accepted");
  const result = await poll(client, "get_result", { runId: started.runId },
    value => value.ready === true);
  assert.equal(result.run.status, "cancelled");
  assert.equal(result.run.tainted, false);
  assert.equal(result.run.workspaceRelease.status, "confirmed");
});

function cancellableExecutor(): Executor {
  return { id: "registered.node", execute: async (request, signal) =>
    new Promise<RunResult>((resolve) => signal.addEventListener("abort", () => resolve({
      ...base(request), executionStatus: "cancelled", outcome: null,
      error: { code: "cancelled", message: "Cancelled by caller.", retryable: false },
    }), { once: true })),
  async cancel(request) { return { runId: request.runId, disposition: "accepted" }; },
  async cleanup(request) { return cleanup(request); } };
}

function base(request: ExecuteRequest) {
  return { runId: request.runId, snapshot: request.snapshot, testId: request.testId,
    parameters: request.parameters, startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(), artifacts: [], cleanup: cleanup(request) };
}

function cleanup(request: Pick<ExecuteRequest, "runId" | "snapshot">) {
  return { runId: request.runId, snapshotId: request.snapshot.snapshotId,
    status: "confirmed" as const, tainted: false, attemptedAt: new Date().toISOString() };
}

async function poll(client: Client, name: string, args: Record<string, unknown>,
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
