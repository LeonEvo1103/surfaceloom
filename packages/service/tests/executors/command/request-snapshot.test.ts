import assert from "node:assert/strict";
import test from "node:test";

import { CommandExecutor } from "../../../src/executors/command/index.js";
import { createOperationId, createRunId, createTaskId } from "../../../src/ids.js";
import { command, FakeChild, options, request, workspaceRoot } from "./helpers.js";

test("execute snapshots correlation and parameters before caller mutation", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const child = new FakeChild();
  const executor = new CommandExecutor("registered.node", options(command([]), {
    spawn: () => {
      queueMicrotask(() => { child.spawn(); child.exit(0); child.closeStreams(); child.close(); });
      return child.asCommandChild();
    },
  }));
  const input = request(root, { parameters: { nested: { value: "original" } } });
  const originalRunId = input.runId;
  const resultPromise = executor.execute(input, new AbortController().signal);
  (input as { runId: string }).runId = createRunId();
  ((input.parameters.nested as { value: string })).value = "polluted";
  const result = await resultPromise;

  assert.equal(result.runId, originalRunId);
  assert.deepEqual(result.parameters, { nested: { value: "original" } });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.parameters));
  assert.ok(Object.isFrozen(result.parameters.nested));
  assert.throws(() => { (result.parameters.nested as { value: string }).value = "late"; }, TypeError);
});

test("request accessors and Proxies are rejected without invoking user code", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const executor = new CommandExecutor("registered.node", options(command([])));
  let calls = 0;
  const accessor = request(root);
  Object.defineProperty(accessor, "runId", {
    enumerable: true,
    get() { calls += 1; return createRunId(); },
  });
  await assert.rejects(executor.execute(accessor, new AbortController().signal), /accessors/u);
  assert.equal(calls, 0);

  const proxied = new Proxy(request(root), {
    get() { calls += 1; return undefined; },
    ownKeys() { calls += 1; return []; },
    getOwnPropertyDescriptor() { calls += 1; return undefined; },
  });
  await assert.rejects(executor.execute(proxied, new AbortController().signal), /Proxy/u);
  assert.equal(calls, 0);

  const nested = request(root, { parameters: new Proxy({}, {
    get() { calls += 1; return undefined; },
    ownKeys() { calls += 1; return []; },
    getOwnPropertyDescriptor() { calls += 1; return undefined; },
  }) });
  await assert.rejects(executor.execute(nested, new AbortController().signal), /Proxy/u);
  assert.equal(calls, 0);
});

test("run replay identity covers workspace, task, links, and definition", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const otherRoot = await workspaceRoot((cleanup) => t.after(cleanup));
  const child = new FakeChild();
  child.killBehavior = (signal) => {
    queueMicrotask(() => { child.exit(null, signal); child.closeStreams(); child.close(); });
    return true;
  };
  let spawned!: () => void;
  const spawnCalled = new Promise<void>((resolve) => { spawned = resolve; });
  const executor = new CommandExecutor("registered.node", options(command([]), {
    spawn: () => { spawned(); queueMicrotask(() => child.spawn()); return child.asCommandChild(); },
  }));
  const first = request(root);
  const running = executor.execute(first, new AbortController().signal);
  await spawnCalled;
  const conflicts = [
    { ...first, workspace: { ...first.workspace, rootPath: otherRoot } },
    { ...first, workspace: { ...first.workspace, operationId: createOperationId() } },
    { ...first, taskId: createTaskId() },
    { ...first, executionLinks: { caseSpecs: [], agentRuns: [], nativeOperations: [] } },
    { ...first, definition: { ...first.definition,
      runtime: { ...first.definition.runtime, kind: "cli" as const } } },
  ];
  for (const conflicting of conflicts) {
    await assert.rejects(executor.execute(conflicting, new AbortController().signal), /another request/u);
  }
  await executor.cancel({ runId: first.runId, reason: "finish test" }, new AbortController().signal);
  await running;
});

test("cleanup rejects a mismatched workspace without cancelling the recorded run", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const otherRoot = await workspaceRoot((cleanup) => t.after(cleanup));
  const child = new FakeChild();
  child.killBehavior = (signal) => {
    queueMicrotask(() => { child.exit(null, signal); child.closeStreams(); child.close(); });
    return true;
  };
  let spawned!: () => void;
  const spawnCalled = new Promise<void>((resolve) => { spawned = resolve; });
  const executor = new CommandExecutor("registered.node", options(command([]), {
    spawn: () => { spawned(); queueMicrotask(() => child.spawn()); return child.asCommandChild(); },
  }));
  const input = request(root);
  const running = executor.execute(input, new AbortController().signal);
  await spawnCalled;
  const rejected = await executor.cleanup({ runId: input.runId,
    snapshot: { ...input.workspace, rootPath: otherRoot } }, new AbortController().signal);
  assert.equal(rejected.status, "unconfirmed");
  assert.equal(rejected.tainted, true);
  assert.deepEqual(child.kills, []);
  await executor.cancel({ runId: input.runId, reason: "finish test" }, new AbortController().signal);
  await running;
});
