import assert from "node:assert/strict";
import test from "node:test";
import { WorkerState } from "../src/worker-state.js";

const cancellation = Object.freeze({ kind: "deadline", requestedAtMs: 10, message: "expired" });
const fulfilled = () => ({ status: "fulfilled", value: { privateValue: "omitted" }, observedAtMs: 5, cancellation: null });

test("settlement requires an actual receipt; a stop request alone remains pending", () => {
  const state = new WorkerState("inProcess", "none");
  assert.equal(state.snapshot().state, "running");
  state.requestStop(); state.requestStop();
  assert.equal(state.snapshot().state, "stopRequested");
  assert.equal(state.snapshot().settlement, null);
  state.unconfirmed("stopUnconfirmed", "No settlement was observed.");
  assert.equal(state.snapshot().state, "unconfirmed");
  assert.equal(state.snapshot().tainted, true);
});

test("late settlement updates current evidence but leaves earlier snapshots and taint intact", () => {
  const state = new WorkerState("inProcess", "none");
  state.requestStop();
  state.unconfirmed("stopUnconfirmed", "Callback may still be running.");
  const before = state.snapshot();
  state.acceptSettlement({ ...fulfilled(), cancellation, observedAtMs: 20 }, true);
  assert.equal(before.state, "unconfirmed");
  assert.equal(before.settlement, null);
  assert.equal(state.snapshot().state, "cooperativeStopped");
  assert.equal(state.snapshot().tainted, true);
});

test("repeated receipts are idempotent and conflicting receipts preserve the first result", () => {
  const state = new WorkerState("inProcess", "none");
  const receipt = fulfilled();
  assert.equal(state.acceptSettlement(receipt, false), true);
  assert.equal(state.acceptSettlement(receipt, false), false);
  assert.equal(state.acceptSettlement(fulfilled(), false), false);
  assert.throws(() => state.acceptSettlement({ ...fulfilled(), status: "rejected", reason: "different" }, false));
  assert.equal(state.snapshot().settlement?.status, "fulfilled");
  assert.equal(state.snapshot().tainted, true);
  assert.equal(state.snapshot().failures[0]?.code, "conflictingReceipt");
});

test("invalid receipt shapes and premature cooperative claims never produce a stop receipt", () => {
  for (const receipt of [null, { status: "stopped" }, { ...fulfilled(), observedAtMs: NaN },
    { ...fulfilled(), cancellation: {} }, { ...fulfilled(), status: "notStarted" },
    { status: "fulfilled", observedAtMs: 1, cancellation: null }]) {
    const state = new WorkerState("inProcess", "none");
    assert.throws(() => state.acceptSettlement(receipt, false));
    assert.equal(state.snapshot().settlement, null);
    assert.equal(state.snapshot().state, "running");
    assert.equal(state.snapshot().tainted, true);
  }
  const state = new WorkerState("inProcess", "none");
  assert.throws(() => state.acceptSettlement(fulfilled(), true));
});

test("receipt getters and revoked proxies are rejected without reading opaque fields", () => {
  let reads = 0;
  const hostile = { get status() { reads += 1; throw new Error("getter ran"); } };
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  for (const input of [hostile, proxy.proxy]) {
    const state = new WorkerState("inProcess", "none");
    assert.throws(() => state.acceptSettlement(input, false));
    assert.equal(state.snapshot().failures[0]?.code, "invalidReceipt");
    assert.doesNotThrow(() => JSON.stringify(state.snapshot()));
  }
  assert.equal(reads, 0);
});

test("task settlement cannot stand in for worker exit, and in-process execution cannot claim termination", () => {
  const node = new WorkerState("nodeWorker", "none");
  node.requestStop();
  assert.throws(() => node.acceptSettlement(fulfilled(), false));
  assert.throws(() => node.confirmTermination(0));
  assert.equal(node.snapshot().exitCode, null);
  const local = new WorkerState("inProcess", "none");
  local.requestStop();
  assert.throws(() => local.observeExit(0));
  assert.throws(() => local.confirmTermination(0));
  assert.equal(local.snapshot().exitCode, null);
});

test("worker termination requires a matching exit, permits duplicates, and rejects conflicting exit codes", () => {
  const state = new WorkerState("nodeWorker", "none");
  state.requestStop(); state.observeExit(1);
  assert.equal(state.snapshot().state, "workerExited");
  state.confirmTermination(1); state.confirmTermination(1); state.observeExit(1);
  assert.equal(state.snapshot().state, "workerTerminated");
  assert.equal(state.snapshot().failures.filter((failure) => failure.code === "forcedTermination").length, 1);
  assert.throws(() => state.observeExit(2));
  assert.throws(() => state.confirmTermination(2));
  assert.equal(state.snapshot().state, "workerTerminated");
  assert.equal(state.snapshot().exitCode, 1);
});

test("stop confirmation never clears unknown external effects or taint", () => {
  const state = new WorkerState("nodeWorker", "possible");
  assert.equal(state.snapshot().externalEffects, "unverified");
  state.requestStop(); state.observeExit(1); state.confirmTermination(1);
  assert.equal(state.snapshot().state, "workerTerminated");
  assert.equal(state.snapshot().externalEffects, "unknown");
  assert.equal(state.snapshot().tainted, true);
  const once = state.snapshot().failures.length;
  state.markExternalEffectsUnknown();
  assert.equal(state.snapshot().failures.length, once);
});

test("diagnostics are deeply frozen JSON metadata and exclude borrowed application values", () => {
  const state = new WorkerState("inProcess", "none");
  const reason = new Error("original failure");
  const receipt = { status: "rejected", reason, observedAtMs: null, cancellation: null };
  state.acceptSettlement(receipt, false);
  reason.message = "mutated later";
  state.acceptSettlement(receipt, false);
  const snapshot = state.snapshot();
  assert.equal(snapshot.settlement?.errorMessage, "original failure");
  assert.equal(snapshot.failures[0]?.message, "original failure");
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.failures));
  assert.ok(Object.isFrozen(snapshot.failures[0]));
  assert.ok(Object.isFrozen(snapshot.settlement));
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  const values = new WorkerState("inProcess", "none");
  values.acceptSettlement({ ...fulfilled(), value: () => {} }, false);
  assert.doesNotMatch(JSON.stringify(values.snapshot()), /privateValue|"value"/);
});
