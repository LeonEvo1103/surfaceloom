import assert from "node:assert/strict";
import test from "node:test";

import {
  bindAgentRun,
  expectAgent,
  type AgentObservationProvider,
  ObservationAssertionError,
} from "../src/index.js";

const runId = "run-000001";
const callId = "run-000001:call-1";
const barrier = Object.freeze({ kind: "barrier" as const, id: "reference.run-000001.done" });

function fakeTime() {
  let now = 0;
  return { now: () => now, sleep: async (durationMs: number) => { now += durationMs; } };
}

function provider(overrides: Partial<AgentObservationProvider> = {}): AgentObservationProvider {
  return {
    readRunState: () => ({ state: "unknown", reason: "run unavailable" }),
    readApproval: () => ({ state: "unknown", reason: "approval unavailable" }),
    readToolCall: () => ({ state: "unknown", reason: "ledger unavailable" }),
    readExternalEffects: () => ({ state: "unknown", reason: "probe unavailable" }),
    ...overrides,
  };
}

test("author facade binds semantic tools to exact call identities and reuses Agent assertions", async () => {
  const seen: string[] = [];
  const source = provider({
    readRunState: (scope) => {
      seen.push(`run:${scope.runId}`);
      return { state: "available", value: { ...scope, state: "completed" } };
    },
    readApproval: (scope) => {
      seen.push(`approval:${scope.callId}`);
      return { state: "available", value: { ...scope, requested: true } };
    },
    readToolCall: (scope) => {
      seen.push(`tool:${scope.callId}`);
      return { state: "available", value: {
        ...scope, requested: 1, started: 1, completed: 1,
      }, completeness: { ...barrier, complete: true } };
    },
    readExternalEffects: (scope) => {
      seen.push(`resource:${scope.resource}`);
      return { state: "available", value: {
        ...scope, boundary: "external", count: 0,
      }, completeness: { ...barrier, complete: true } };
    },
  });
  const run = bindAgentRun({ provider: source, runId, approvalCallId: callId,
    tools: [{ toolId: "write-note", callId }],
    assertion: { timeoutMs: 10, clock: fakeTime() } });

  await expectAgent(run).toHaveRunState("completed");
  await expectAgent(run).toHaveRequestedApproval();
  await expectAgent(run.tool("write-note")).toHaveLifecyclePhase("started");
  await expectAgent(run.tool("write-note")).toHaveExecutedExactlyOnce({ barrier });
  await expectAgent(run.resource("notes.external")).toHaveNoExternalEffect({ barrier });

  assert.deepEqual(seen, [
    `run:${runId}`,
    `approval:${callId}`,
    `tool:${callId}`,
    `tool:${callId}`,
    "resource:notes.external",
  ]);
});

test("facade cannot turn an incomplete exact-call or local effect observation into proof", async () => {
  const clock = fakeTime();
  const run = bindAgentRun({ provider: provider({
    readToolCall: (scope) => ({ state: "available", value: {
      ...scope, requested: 1, started: 1, completed: 1,
    } }),
    readExternalEffects: (scope) => ({ state: "available", value: {
      ...scope, boundary: "local", count: 0,
    }, completeness: { ...barrier, complete: true } } as never),
  }), runId, approvalCallId: callId, tools: [{ toolId: "write-note", callId }],
  assertion: { timeoutMs: 2, pollIntervalMs: 1, clock } });

  await assert.rejects(
    expectAgent(run.tool("write-note")).toHaveExecutedExactlyOnce({ barrier }),
    (error: unknown) => error instanceof ObservationAssertionError
      && error.result.status === "timedOut",
  );
  await assert.rejects(
    expectAgent(run.resource("notes.local")).toHaveNoExternalEffect({ barrier }),
    (error: unknown) => error instanceof ObservationAssertionError
      && error.result.status === "timedOut",
  );
});

test("facade rejects JavaScript phase and interval-barrier bypasses before reading", () => {
  const interval = Object.freeze({ kind: "interval" as const, fromMs: 0, toMs: 10 });
  let reads = 0;
  const source = provider({
    readToolCall: (scope) => {
      reads += 1;
      return { state: "available", value: {
        ...scope, requested: 0, started: 0, completed: 0,
      }, completeness: { ...interval, complete: true } };
    },
    readExternalEffects: (scope) => {
      reads += 1;
      return { state: "available", value: {
        ...scope, boundary: "external", count: 0,
      }, completeness: { ...interval, complete: true } };
    },
  });
  const run = bindAgentRun({ provider: source, runId, approvalCallId: "2",
    tools: [{ toolId: "write-note", callId: "2" }], assertion: { timeoutMs: 1 } });
  const tool = expectAgent(run.tool("write-note"));
  assert.throws(() => tool.toHaveLifecyclePhase("callId" as never), /phase must be/u);
  assert.throws(() => tool.toHaveExecutedExactlyOnce({ barrier: interval as never }),
    /named completion barrier/u);
  assert.throws(() => expectAgent(run.resource("notes.external"))
    .toHaveNoExternalEffect({ barrier: interval as never }), /named completion barrier/u);
  assert.equal(reads, 0);
});

test("binding rejects ambiguous tools and expectAgent rejects fabricated author objects", () => {
  const source = provider();
  assert.throws(() => bindAgentRun({ provider: source, runId, approvalCallId: callId,
    tools: [{ toolId: "write-note", callId }, { toolId: "write-note", callId: "call-2" }],
    assertion: { timeoutMs: 10 } }), /Duplicate Agent tool binding/u);
  assert.throws(() => bindAgentRun({ provider: source, runId, approvalCallId: callId,
    tools: [{ toolId: "write-note", callId }, { toolId: "send-note", callId }],
    assertion: { timeoutMs: 10 } }), /Duplicate Agent call binding/u);
  const run = bindAgentRun({ provider: source, runId, approvalCallId: callId,
    tools: [{ toolId: "write-note", callId }], assertion: { timeoutMs: 10 } });
  assert.throws(() => run.tool("missing-tool"), /no exact call binding/u);
  assert.throws(() => expectAgent({ runId, tool: run.tool, resource: run.resource } as never),
    /requires an author facade/u);
});
