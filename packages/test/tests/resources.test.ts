import assert from "node:assert/strict";
import test from "node:test";
import { ResourceScope, type ResourceCleanupReceipt, type ResourceRegistration } from "../src/resources.js";

test("owned resources close in reverse order and borrowed resources remain borrowed", async () => {
  const scope = new ResourceScope();
  const calls: string[] = [];
  for (const id of ["host", "context"]) {
    scope.register({ id, ownership: "owned", cleanup: () => { calls.push(id); return { status: "released" }; } });
  }
  scope.register({ id: "existing-app", ownership: "borrowed" });
  assert.deepEqual(scope.snapshot().remaining, [
    { id: "existing-app", ownership: "borrowed" },
    { id: "context", ownership: "owned" },
    { id: "host", ownership: "owned" },
  ]);
  const result = await scope.close();
  assert.deepEqual(calls, ["context", "host"]);
  assert.deepEqual(result.outcomes, [
    { id: "existing-app", ownership: "borrowed", status: "borrowed" },
    { id: "context", ownership: "owned", status: "released" },
    { id: "host", ownership: "owned", status: "released" },
  ]);
  assert.equal(result.status, "passed");
  assert.equal(result.tainted, false);
  assert.deepEqual(result.remaining, []);
});

test("every cleanup is attempted and early body failure stays primary", async () => {
  const scope = new ResourceScope();
  const calls: string[] = [];
  for (const id of ["first", "second"]) {
    scope.register({ id, ownership: "owned", cleanup: async () => { calls.push(id); throw new Error(`${id} failed`); } });
  }
  scope.recordFailure("body", new Error("original body failure"));
  const result = await scope.close();
  assert.deepEqual(calls, ["second", "first"]);
  assert.deepEqual(result.failures.map(({ message }) => message), ["original body failure", "second failed", "first failed"]);
  assert.equal(result.primaryFailure, result.failures[0]);
  assert.equal(result.status, "failed");
  assert.equal(result.tainted, true);
});

test("cleanup failures cannot pass without an earlier execution failure", async () => {
  const scope = new ResourceScope();
  scope.register({ id: "process", ownership: "owned", cleanup: () => { throw new Error("close failed"); } });
  const result = await scope.close();
  assert.equal(result.primaryFailure?.code, "cleanupFailed");
  assert.equal(result.status, "failed");
  assert.equal(result.outcomes[0]?.status, "failed");
});

test("cleanup completion cannot erase setup failure or taint a fully released resource", async () => {
  const scope = new ResourceScope();
  scope.recordFailure("fixtureSetup", new Error("setup failed first"));
  scope.register({ id: "partial", ownership: "owned", cleanup: async () => ({ status: "released" }) });
  const result = await scope.close();
  assert.equal(result.primaryFailure?.phase, "fixtureSetup");
  assert.equal(result.status, "failed");
  assert.equal(result.tainted, false);
});

test("the first setup cause in an aggregate stays primary before resource cleanup failures", async () => {
  const scope = new ResourceScope();
  scope.recordFailure("setup", new AggregateError([new Error("setup failed"), new Error("rollback failed")], "Setup aggregate"));
  scope.register({ id: "app", ownership: "owned", cleanup: () => { throw new Error("cleanup failed"); } });
  const result = await scope.close();
  assert.equal(result.primaryFailure?.message, "setup failed");
  assert.equal(result.failures[1]?.message, "cleanup failed");
});

test("concurrent, repeated, and reentrant close calls share one promise", async () => {
  const scope = new ResourceScope();
  let calls = 0;
  let reentrant: Promise<unknown> | undefined;
  scope.register({ id: "once", ownership: "owned", cleanup: () => {
    calls += 1;
    reentrant = scope.close();
    return { status: "released" };
  } });
  const first = scope.close();
  assert.equal(scope.close(), first);
  const result = await first;
  assert.equal(reentrant, first);
  assert.equal(scope.close(), first);
  assert.equal(await scope.close(), result);
  assert.equal(calls, 1);
});

test("registration snapshots fields and options without freezing provider inputs", async () => {
  const options = { cleanupTimeoutMs: 100 };
  const scope = new ResourceScope(options);
  const input = { id: "original", ownership: "owned" as const,
    cleanup: (): ResourceCleanupReceipt => ({ status: "released" }) };
  scope.register(input);
  input.id = "changed";
  input.cleanup = () => { throw new Error("changed cleanup must not run"); };
  options.cleanupTimeoutMs = 0;
  const result = await scope.close();
  assert.deepEqual(result.outcomes, [{ id: "original", ownership: "owned", status: "released" }]);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(options), false);
});

test("all result arrays, outcomes, and failure records are frozen snapshots", async () => {
  const scope = new ResourceScope();
  const error = new Error("original");
  scope.recordFailure("body", error);
  error.message = "mutated";
  scope.register({ id: "unknown", ownership: "owned", cleanup: () => ({ status: "unconfirmed", reason: "still alive" }) });
  const before = scope.snapshot();
  const result = await scope.close();
  assert.equal(before.state, "open");
  assert.equal(before.outcomes.length, 0);
  assert.deepEqual(before.remaining, [{ id: "unknown", ownership: "owned" }]);
  assert.equal(result.primaryFailure?.message, "original");
  for (const value of [result, result.outcomes, result.remaining, result.failures,
    ...result.outcomes, ...result.remaining, ...result.failures]) {
    assert.ok(Object.isFrozen(value));
  }
  assert.throws(() => (result.failures as unknown[]).push("mutation"));
});

test("duplicate ids are rejected, retained as failures, and never replace accepted cleanup", async () => {
  const scope = new ResourceScope();
  let original = 0;
  scope.register({ id: "same", ownership: "owned", cleanup: () => { original += 1; return { status: "released" }; } });
  assert.throws(() => scope.register({ id: "same", ownership: "borrowed" }), /already registered/);
  const result = await scope.close();
  assert.equal(original, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.tainted, true);
  assert.equal(result.primaryFailure?.code, "duplicateResource");
});

test("late registration is not accepted and remains visible after an earlier close snapshot", async () => {
  const scope = new ResourceScope();
  const result = await scope.close();
  let called = false;
  const late: ResourceRegistration = { id: "late", ownership: "owned", cleanup: () => {
    called = true; return { status: "released" };
  } };
  assert.throws(() => scope.register(late), /no longer accepts/);
  assert.equal(called, false, "a rejected registration does not transfer ownership");
  assert.equal(result.status, "passed", "already delivered immutable snapshots describe their original time");
  assert.equal(scope.snapshot().status, "failed");
  assert.equal(scope.snapshot().tainted, true);
  assert.equal(scope.snapshot().primaryFailure?.code, "scopeClosed");
});

test("registration rejected during cleanup cannot be swallowed to produce a pass", async () => {
  const scope = new ResourceScope();
  scope.register({ id: "initial", ownership: "owned", cleanup: () => {
    assert.throws(() => scope.register({ id: "late", ownership: "borrowed" }));
    return { status: "released" };
  } });
  assert.equal((await scope.close()).status, "failed");
});

test("recordFailure rejects once closing starts and the close result cannot pass", async () => {
  const scope = new ResourceScope();
  const closing = scope.close();
  assert.equal(scope.snapshot().state, "closing");
  assert.throws(() => scope.recordFailure("body", new Error("late body failure")), /no longer accepts failure records/);
  const result = await closing;
  assert.equal(result.status, "failed");
  assert.equal(result.tainted, true);
  assert.equal(result.primaryFailure?.code, "scopeClosed");
  assert.equal(result.primaryFailure?.phase, "failureRecording");
  assert.deepEqual(scope.snapshot(), result);
});

test("recordFailure rejected inside cleanup remains a failure even when the caller catches it", async () => {
  const scope = new ResourceScope();
  scope.register({ id: "first", ownership: "owned", cleanup: () => ({ status: "released" }) });
  scope.register({ id: "second", ownership: "owned", cleanup: () => {
    assert.throws(() => scope.recordFailure("body", new Error("late body failure")));
    return { status: "released" };
  } });
  const result = await scope.close();
  assert.equal(result.status, "failed");
  assert.equal(result.tainted, true);
  assert.deepEqual(result.outcomes.map(({ status }) => status), ["released", "released"]);
  assert.equal(result.failures.length, 1);
});

test("recordFailure after close throws and taints current state without mutating its earlier receipt", async () => {
  const scope = new ResourceScope();
  const closing = scope.close();
  const delivered = await closing;
  assert.equal(delivered.status, "passed");
  assert.throws(() => scope.recordFailure("body", new Error("late body failure")), /no longer accepts failure records/);
  const final = scope.snapshot();
  assert.equal(final.state, "closed");
  assert.equal(final.status, "failed");
  assert.equal(final.tainted, true);
  assert.equal(final.primaryFailure?.code, "scopeClosed");
  assert.equal(delivered.status, "passed", "immutable receipts cannot certify writes made after their snapshot");
  assert.equal(delivered.failures.length, 0);
  assert.equal(scope.close(), closing, "idempotent close never replays cleanup or rewrites its delivered receipt");
  assert.ok(Object.isFrozen(final.failures[0]));
});

test("rejected late failure records cannot replace an earlier body cause", async () => {
  const scope = new ResourceScope();
  scope.recordFailure("body", new Error("original body failure"));
  await scope.close();
  assert.throws(() => scope.recordFailure("body", new Error("late body failure")));
  const final = scope.snapshot();
  assert.equal(final.primaryFailure?.message, "original body failure");
  assert.deepEqual(final.failures.map(({ code }) => code), ["executionFailed", "scopeClosed"]);
  assert.equal(final.tainted, true);
});
