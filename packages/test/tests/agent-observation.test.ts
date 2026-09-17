import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAgentApprovalRequested,
  assertAgentResourceHasNoExternalEffect,
  assertAgentRunState,
  assertAgentToolCall,
  assertAgentToolCallExactlyOnce,
  type AgentObservationProvider,
  ObservationAssertionError,
  toHaveExecutedExactlyOnce,
  toHaveNoExternalEffect,
  toHaveRequestedApproval,
  toHaveRunState,
  toHaveToolCall,
} from "../src/index.js";

const run = Object.freeze({ runId: "run-000001" });
const call = Object.freeze({ ...run, callId: "call-000001" });
const resource = Object.freeze({ ...run, resource: "fixture.external-note" });

test("author-facing Agent assertion names use the same fail-closed contracts", () => {
  assert.equal(toHaveRunState, assertAgentRunState);
  assert.equal(toHaveRequestedApproval, assertAgentApprovalRequested);
  assert.equal(toHaveToolCall, assertAgentToolCall);
  assert.equal(toHaveExecutedExactlyOnce, assertAgentToolCallExactlyOnce);
  assert.equal(toHaveNoExternalEffect, assertAgentResourceHasNoExternalEffect);
});

function fakeTime() {
  let now = 0;
  return { clock: { now: () => now, sleep: async (ms: number) => { now += ms; } } };
}

function provider(overrides: Partial<AgentObservationProvider> = {}): AgentObservationProvider {
  return {
    readRunState: () => ({ state: "unknown", reason: "run state unavailable" }),
    readApproval: () => ({ state: "unknown", reason: "approval stream unavailable" }),
    readToolCall: () => ({ state: "unknown", reason: "tool ledger unavailable" }),
    readExternalEffects: () => ({ state: "unknown", reason: "effect ledger unavailable" }),
    ...overrides,
  };
}

test("run-state and approval assertions reread exact run and call scopes", async () => {
  const time = fakeTime();
  const runAttempts: number[] = [];
  const approvalAttempts: number[] = [];
  const source = provider({
    readRunState: (scope, context) => {
      assert.deepEqual(scope, run);
      runAttempts.push(context.attempt);
      return { state: "available", value: { ...scope,
        state: context.attempt === 1 ? "running" : "completed" } };
    },
    readApproval: (scope, context) => {
      assert.deepEqual(scope, call);
      approvalAttempts.push(context.attempt);
      return { state: "available", value: context.attempt === 1
        ? { ...scope, requested: false }
        : { ...scope, requested: true } };
    },
  });

  const state = await assertAgentRunState(source, run, "completed", {
    timeoutMs: 10, pollIntervalMs: 1, clock: time.clock,
  });
  const approval = await assertAgentApprovalRequested(source, call, {
    timeoutMs: 10, pollIntervalMs: 1, clock: time.clock,
  });

  assert.equal(state.status, "passed");
  assert.equal(approval.status, "passed");
  assert.deepEqual(runAttempts, [1, 2]);
  assert.deepEqual(approvalAttempts, [1, 2]);
});

test("tool-call assertions bind a stable call and distinguish observed from exactly once", async () => {
  const time = fakeTime();
  const source = provider({
    readToolCall: (scope) => ({ state: "available", value: {
      ...scope, requested: 1, started: 1, completed: 0,
    } }),
  });

  const observed = await assertAgentToolCall(source, call, "started", {
    timeoutMs: 10, clock: time.clock,
  });
  const barrier = Object.freeze({ kind: "barrier" as const, id: "run-000001.done" });
  const once = await assertAgentToolCallExactlyOnce(provider({
    readToolCall: (scope, context) => ({ state: "available", value: {
      ...scope, requested: 1, started: 1, completed: 1,
    }, ...(context.attempt === 1 ? {} : { completeness: { ...barrier, complete: true } }) }),
  }), call, {
    completeness: barrier, timeoutMs: 10, pollIntervalMs: 1, clock: time.clock,
  });
  assert.equal(observed.status, "passed");
  assert.equal(once.status, "passed");
  assert.equal(once.attempts, 2, "an exact count is not established by an open ledger");

  const duplicate = provider({ readToolCall: (scope) => ({ state: "available", value: {
    ...scope, requested: 2, started: 2, completed: 2,
  }, completeness: { ...barrier, complete: true } }) });
  await assert.rejects(assertAgentToolCallExactlyOnce(duplicate, call, {
    completeness: barrier, timeoutMs: 2, pollIntervalMs: 1, clock: fakeTime().clock,
  }), (error: unknown) => error instanceof ObservationAssertionError
    && error.result.status === "timedOut");
});

test("tool-call assertions reject impossible lifecycle count ordering", async () => {
  for (const value of [
    { ...call, requested: 0, started: 1, completed: 0 },
    { ...call, requested: 1, started: 1, completed: 2 },
  ]) {
    const source = provider({ readToolCall: () => ({ state: "available", value: { ...value } }) });
    await assert.rejects(assertAgentToolCall(source, call, "started", {
      timeoutMs: 2, pollIntervalMs: 1, clock: fakeTime().clock,
    }), (error: unknown) => error instanceof ObservationAssertionError
      && error.result.status === "timedOut");
  }
});

test("zero external effects require exact resource scope and the requested complete barrier", async () => {
  const time = fakeTime();
  const barrier = Object.freeze({ kind: "barrier" as const, id: "run-000001.done" });
  const observations = [
    { state: "available" as const, value: { ...resource, boundary: "external" as const, count: 0 } },
    { state: "unknown" as const, reason: "truncated effect ledger" },
    { state: "read-failed" as const, error: { code: "ledgerReadFailed", message: "ledger unavailable" } },
    { state: "available" as const, value: { ...resource, boundary: "external" as const, count: 0 },
      completeness: { ...barrier, complete: false } },
    { state: "available" as const, value: { ...resource, boundary: "external" as const, count: 0 },
      completeness: { ...barrier, complete: true }, evidenceIds: ["effect-ledger.complete"] },
  ];
  const attempts: number[] = [];
  const source = provider({
    readExternalEffects: (scope, context) => {
      assert.deepEqual(scope, resource);
      attempts.push(context.attempt);
      return observations[context.attempt - 1]!;
    },
  });

  const result = await assertAgentResourceHasNoExternalEffect(source, resource, {
    completeness: barrier, timeoutMs: 10, pollIntervalMs: 1, clock: time.clock,
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
  assert.equal(result.lastReadError?.error.code, "ledgerReadFailed");
  assert.deepEqual(result.evidenceIds, ["effect-ledger.complete"]);
});

test("unknown, truncated, read-failed, and external effects never establish zero", async () => {
  const barrier = Object.freeze({ kind: "barrier" as const, id: "run-000001.done" });
  for (const observation of [
    { state: "unknown", reason: "truncated ledger" },
    { state: "read-failed", error: { code: "offline", message: "probe offline" } },
    { state: "available", value: { ...resource, resource: "fixture.another", boundary: "external", count: 0 },
      completeness: { ...barrier, complete: true } },
    { state: "available", value: { ...resource, boundary: "external", count: 1 },
      completeness: { ...barrier, complete: true } },
  ] as const) {
    const source = provider({ readExternalEffects: () => structuredClone(observation) });
    await assert.rejects(assertAgentResourceHasNoExternalEffect(source, resource, {
      completeness: barrier, timeoutMs: 2, pollIntervalMs: 1, clock: fakeTime().clock,
    }), (error: unknown) => error instanceof ObservationAssertionError
      && error.result.status === "timedOut");
  }
});

test("invalid scopes and barrier requirements reject before a provider read", async () => {
  let reads = 0;
  const source = provider({ readExternalEffects: () => {
    reads += 1;
    return { state: "available", value: { ...resource, boundary: "external", count: 0 } };
  } });
  assert.throws(() => assertAgentResourceHasNoExternalEffect(source,
    { ...resource, resource: "*" }, {
      completeness: { kind: "barrier", id: "run-000001.done" },
      timeoutMs: 1, clock: fakeTime().clock,
    }), /stable machine id/);
  await assert.rejects(assertAgentResourceHasNoExternalEffect(source, resource,
    { timeoutMs: 1, clock: fakeTime().clock } as never), /completion barrier/);
  assert.equal(reads, 0);
});
