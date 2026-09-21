import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
  AgentTestService, CommandExecutor, createSurfaceLoomMcpHandler, FileArtifactStore,
  FileRunStore, listenSurfaceLoomMcp, LocalGitWorkspaceProvider, PersistentRunService,
  TestCatalog,
} from "../../src/index.js";
import { validDefinition } from "../fixtures.js";
import { createGitFixture } from "../workspaces/git-fixture.js";

test("MCP runs a registered Node command in an immutable Git snapshot", async (t) => {
  const fixture = await createGitFixture();
  t.after(() => fixture.dispose());
  const provider = new LocalGitWorkspaceProvider({ sourceRoot: fixture.sourceRoot,
    snapshotRoot: fixture.snapshotRoot });
  const rawDefinition = validDefinition();
  rawDefinition.output = { resultFormat: "surfaceloom.run-result/v1", artifacts: [] };
  const executor = new CommandExecutor("registered.node", {
    commands: [{ testId: "service-test:reference/smoke", executorId: "registered.node",
      executable: process.execPath, argv: ["-e", "process.stdout.write('mcp-command-ok')"],
      cwd: ".", inheritEnvironment: [], timeoutMs: 2_000,
      exitCodes: { passed: [0], failed: [1] } }],
    allowedCwds: ["."], allowedEnvironment: [],
    processTree: { launch: (spawn, executable, argv, options) => ({
      child: spawn(executable, argv, options),
      handle: { cleanup: async () => ({ status: "confirmed" as const }) },
    }) },
  });
  const persistent = await PersistentRunService.create({
    runStore: await FileRunStore.open(path.join(fixture.root, "runs")),
    artifactStore: await FileArtifactStore.open(path.join(fixture.root, "artifacts")),
    executor, workspaceLifecycle: provider,
  });
  const service = new AgentTestService({ catalog: new TestCatalog([rawDefinition]),
    runs: persistent, workspaceProvider: provider,
    workspaceSources: { repository: { provider: "local-git", locator: "fixture-repo" } } });
  const http = await listenSurfaceLoomMcp(createSurfaceLoomMcpHandler(service));
  t.after(() => http.close());
  const client = new Client({ name: "surfaceloom-command-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(http.url));
  t.after(() => client.close());

  const prepare = data(await client.callTool({ name: "prepare",
    arguments: { sourceKey: "repository", revision: fixture.revision } }));
  const operation = await poll(client, "status", { kind: "operation",
    operationId: prepare.operationId }, value => value.operation?.status === "ready");
  const started = data(await client.callTool({ name: "run", arguments: {
    requestId: "registered-command", snapshotId: operation.operation.snapshotId,
    testId: "service-test:reference/smoke", parameters: { locale: "zh-CN" },
  } }));
  const result = await poll(client, "get_result", { runId: started.runId },
    value => value.ready === true);
  assert.equal(result.run.status, "completed");
  assert.equal(result.run.outcome, "passed");
  assert.equal(result.run.executionLinks, undefined);
  assert.equal(result.run.cleanup.status, "confirmed");
  assert.equal(result.run.workspaceRelease.status, "confirmed");
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
