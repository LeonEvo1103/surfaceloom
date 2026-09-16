import assert from "node:assert/strict";
import test from "node:test";
import { ResourceScope, type ResourceCleanupReceipt } from "../src/resources.js";

test("closing snapshots retain completed outcomes and remaining cleanup order", async () => {
  const scope = new ResourceScope();
  let release!: (receipt: ResourceCleanupReceipt) => void;
  let pendingStarted!: () => void;
  const started = new Promise<void>((resolve) => { pendingStarted = resolve; });
  const pending = new Promise<ResourceCleanupReceipt>((resolve) => { release = resolve; });
  scope.register({ id: "pending", ownership: "owned", cleanup: () => {
    pendingStarted(); return pending;
  } });
  scope.register({ id: "completed", ownership: "owned", cleanup: () => ({ status: "released" }) });
  const closing = scope.close();
  await started;
  const snapshot = scope.snapshot();
  assert.equal(snapshot.state, "closing");
  assert.deepEqual(snapshot.outcomes, [{ id: "completed", ownership: "owned", status: "released" }]);
  assert.deepEqual(snapshot.remaining, [{ id: "pending", ownership: "owned" }]);
  assert.ok(Object.isFrozen(snapshot.remaining));
  assert.ok(Object.isFrozen(snapshot.remaining[0]));
  release({ status: "released" });
  assert.deepEqual((await closing).remaining, []);
});

test("unconfirmed release is tainted even when the cleanup callback fulfills", async () => {
  const scope = new ResourceScope();
  scope.register({ id: "app", ownership: "owned", cleanup: async () => ({ status: "unconfirmed", reason: "exit not observed" }) });
  const result = await scope.close();
  assert.equal(result.status, "failed");
  assert.equal(result.tainted, true);
  assert.equal(result.outcomes[0]?.status, "unconfirmed");
  assert.equal(result.primaryFailure?.code, "cleanupUnconfirmed");
});

test("a pending cleanup times out without claiming release and remaining cleanup still runs", { timeout: 1000 }, async () => {
  const scope = new ResourceScope({ cleanupTimeoutMs: 15 });
  const calls: string[] = [];
  let settle: (value: ResourceCleanupReceipt) => void = () => assert.fail("pending cleanup did not start");
  const pending = new Promise<ResourceCleanupReceipt>((resolve) => { settle = resolve; });
  scope.register({ id: "earlier", ownership: "owned", cleanup: () => { calls.push("earlier"); return { status: "released" }; } });
  scope.register({ id: "pending", ownership: "owned", cleanup: () => { calls.push("pending"); return pending; } });
  try {
    const result = await scope.close();
    assert.deepEqual(calls, ["pending", "earlier"]);
    assert.equal(result.outcomes[0]?.status, "unconfirmed");
    assert.equal(result.primaryFailure?.code, "cleanupTimedOut");
    assert.equal(result.tainted, true);
    settle({ status: "released" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(scope.snapshot().outcomes[0]?.status, "unconfirmed", "late settlement cannot retroactively certify timely cleanup");
  } finally { settle({ status: "released" }); }
});

test("late cleanup rejection is observed without replacing the timeout or earlier failure", { timeout: 1000 }, async () => {
  const scope = new ResourceScope({ cleanupTimeoutMs: 10 });
  let reject: (error: unknown) => void = () => assert.fail("pending cleanup did not start");
  const pending = new Promise<ResourceCleanupReceipt>((_resolve, fail) => { reject = fail; });
  scope.recordFailure("body", new Error("body failed"));
  scope.register({ id: "pending", ownership: "owned", cleanup: () => pending });
  try {
    const result = await scope.close();
    reject(new Error("late cleanup failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result.primaryFailure?.message, "body failed");
    assert.deepEqual(scope.snapshot().failures.map(({ code }) => code), ["executionFailed", "cleanupTimedOut"]);
  } finally { reject(new Error("test cleanup")); }
});

test("each cleanup gets an independent wait budget and all pending callbacks are attempted", { timeout: 1000 }, async () => {
  const scope = new ResourceScope({ cleanupTimeoutMs: 10 });
  const calls: string[] = [];
  const resolvers: (() => void)[] = [];
  for (const id of ["first", "second"]) {
    scope.register({ id, ownership: "owned", cleanup: () => {
      calls.push(id);
      return new Promise<ResourceCleanupReceipt>((resolve) => { resolvers.push(() => resolve({ status: "released" })); });
    } });
  }
  try {
    const result = await scope.close();
    assert.deepEqual(calls, ["second", "first"]);
    assert.deepEqual(result.outcomes.map(({ status }) => status), ["unconfirmed", "unconfirmed"]);
  } finally { for (const resolve of resolvers) resolve(); }
});

test("a synchronous callback that exceeds its wait budget cannot certify timely release", async () => {
  const scope = new ResourceScope({ cleanupTimeoutMs: 1 });
  scope.register({ id: "slow", ownership: "owned", cleanup: () => {
    const end = performance.now() + 4;
    while (performance.now() < end) { /* Deliberately finite event-loop blockage. */ }
    return { status: "released" };
  } });
  assert.equal((await scope.close()).primaryFailure?.code, "cleanupTimedOut");
});

test("void, boolean, unknown, or malformed receipts cannot confirm resource release", async () => {
  for (const value of [undefined, true, null, { status: "success" }, { status: "unconfirmed", reason: "" },
    { status: "released", reason: "still running" }]) {
    const scope = new ResourceScope();
    scope.register({ id: "invalid", ownership: "owned", cleanup: () => value as ResourceCleanupReceipt });
    const result = await scope.close();
    assert.equal(result.primaryFailure?.code, "invalidCleanupReceipt");
    assert.equal(result.status, "failed");
    assert.equal(result.tainted, true);
  }
});
