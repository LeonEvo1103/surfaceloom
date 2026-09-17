import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { trackNodeWorker } from "../src/worker-node.js";

const options = { ownership: "owned", externalEffects: "none" } as const;
const idleSource = "require('node:worker_threads').parentPort.postMessage('ready'); setInterval(() => {}, 1000);";

test("a real busy Node Worker stops only after native termination and its exit event", { timeout: 5000 }, async (t) => {
  const worker = new Worker("require('node:worker_threads').parentPort.postMessage('ready'); while (true) {}", { eval: true });
  t.after(async () => { await worker.terminate(); });
  const handle = trackNodeWorker(worker, options);
  await once(worker, "message");
  assert.equal(handle.snapshot().state, "running");
  const stop = handle.terminate({ timeoutMs: 1000 });
  assert.equal(handle.terminate({ timeoutMs: 1 }), stop, "termination must not be replayed");
  const result = await stop;
  assert.equal(result.state, "workerTerminated");
  assert.equal(result.isolation, "nodeWorker");
  assert.equal(result.exitCode, 1);
  assert.equal(result.tainted, true, "forced interruption does not authorize resource reuse");
  assert.equal(worker.threadId, -1);
  await handle.exited;
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.failures));
});

test("natural worker exit remains distinct from forced termination", { timeout: 5000 }, async () => {
  const worker = new Worker("42", { eval: true });
  const handle = trackNodeWorker(worker, options);
  const result = await handle.exited;
  assert.equal(result.state, "workerExited");
  assert.equal(result.exitCode, 0);
  assert.equal(result.tainted, false);
  assert.equal((await handle.terminate({ timeoutMs: 10 })).state, "workerExited");
  assert.throws(() => trackNodeWorker(worker, options), /live Node Worker/);
});

test("termination fulfillment without an exit event is not a stop receipt", { timeout: 5000 }, async (t) => {
  const worker = new Worker(idleSource, { eval: true });
  const nativeTerminate = worker.terminate.bind(worker);
  t.after(async () => { await nativeTerminate(); });
  worker.terminate = async () => 0;
  const handle = trackNodeWorker(worker, options);
  await once(worker, "message");
  const result = await handle.terminate({ timeoutMs: 10 });
  assert.equal(result.state, "unconfirmed");
  assert.equal(result.exitCode, null);
  assert.notEqual(worker.threadId, -1);
  await nativeTerminate();
  assert.equal(handle.snapshot().state, "workerExited", "mismatched exit must not confirm the earlier fake receipt");
  assert.equal(handle.snapshot().tainted, true);
  assert.ok(handle.snapshot().failures.some((failure) => failure.code === "invalidReceipt"));
  assert.equal(result.state, "unconfirmed", "the earlier returned snapshot stays frozen");
});

test("native termination rejection preserves failure and a later actual exit", { timeout: 5000 }, async (t) => {
  const worker = new Worker(idleSource, { eval: true });
  const nativeTerminate = worker.terminate.bind(worker);
  t.after(async () => { await nativeTerminate(); });
  const error = new Error("termination denied");
  worker.terminate = async () => { throw error; };
  const handle = trackNodeWorker(worker, options);
  await once(worker, "message");
  const result = await handle.terminate({ timeoutMs: 1000 });
  assert.equal(result.state, "unconfirmed");
  assert.equal(result.failures[0]?.code, "terminationFailed");
  assert.equal(result.failures[0]?.message, "termination denied");
  await nativeTerminate();
  const late = await handle.exited;
  assert.equal(late.state, "workerExited");
  assert.equal(late.tainted, true);
  assert.equal(late.failures[0]?.message, "termination denied");
});

test("hanging termination returns unconfirmed and captures a late rejection", { timeout: 5000 }, async (t) => {
  const worker = new Worker(idleSource, { eval: true });
  const nativeTerminate = worker.terminate.bind(worker);
  t.after(async () => { await nativeTerminate(); });
  let reject!: (reason: unknown) => void;
  worker.terminate = () => new Promise<number>((_resolve, no) => { reject = no; });
  const handle = trackNodeWorker(worker, options);
  await once(worker, "message");
  const result = await handle.terminate({ timeoutMs: 10 });
  assert.equal(result.state, "unconfirmed");
  reject(new Error("late failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(handle.snapshot().failures.some((failure) => failure.message === "late failure"));
  assert.equal(result.failures.some((failure) => failure.message === "late failure"), false);
});

test("malformed termination receipts fail instead of claiming a stopped worker", { timeout: 5000 }, async (t) => {
  const worker = new Worker(idleSource, { eval: true });
  const nativeTerminate = worker.terminate.bind(worker);
  t.after(async () => { await nativeTerminate(); });
  worker.terminate = async () => "stopped" as never;
  const handle = trackNodeWorker(worker, options);
  await once(worker, "message");
  const result = await handle.terminate({ timeoutMs: 1000 });
  assert.equal(result.state, "unconfirmed");
  assert.equal(result.exitCode, null);
  assert.equal(result.failures[0]?.code, "invalidReceipt");
});

test("forced termination cannot certify external effect outcomes", { timeout: 5000 }, async (t) => {
  const worker = new Worker(idleSource, { eval: true });
  t.after(async () => { await worker.terminate(); });
  const input = { ownership: "owned" as const, externalEffects: "possible" as "none" | "possible" };
  const handle = trackNodeWorker(worker, input);
  input.externalEffects = "none";
  await once(worker, "message");
  const result = await handle.terminate({ timeoutMs: 1000 });
  assert.equal(result.state, "workerTerminated");
  assert.equal(result.externalEffects, "unknown");
  assert.equal(result.tainted, true);
  assert.equal(result.failures[0]?.code, "externalEffectsUnknown");
});

test("invalid wait budgets and borrowed worker declarations do not invoke termination", { timeout: 5000 }, async (t) => {
  const worker = new Worker(idleSource, { eval: true });
  const nativeTerminate = worker.terminate.bind(worker);
  t.after(async () => { await nativeTerminate(); });
  let calls = 0;
  worker.terminate = () => { calls += 1; return nativeTerminate(); };
  assert.throws(() => trackNodeWorker(worker, { ...options, ownership: "borrowed" } as never), /caller-owned/);
  const handle = trackNodeWorker(worker, options);
  assert.throws(() => handle.terminate({ timeoutMs: -1 }), /timeoutMs/);
  assert.equal(calls, 0);
  assert.equal(handle.snapshot().state, "running");
  await handle.terminate({ timeoutMs: 1000 });
  assert.equal(calls, 1);
});

test("uncaught worker errors stay diagnostic and only exit confirms that execution ended", { timeout: 5000 }, async () => {
  const worker = new Worker("throw new Error('worker crashed')", { eval: true });
  const handle = trackNodeWorker(worker, options);
  const result = await handle.exited;
  assert.equal(result.state, "workerExited");
  assert.equal(result.exitCode, 1);
  assert.equal(result.tainted, true);
  assert.equal(result.failures[0]?.code, "workerError");
  assert.match(result.failures[0]?.message ?? "", /worker crashed/);
});

test("external abort bounds waiting but does not revoke an already requested native termination", { timeout: 5000 }, async (t) => {
  const worker = new Worker(idleSource, { eval: true });
  t.after(async () => { await worker.terminate(); });
  const handle = trackNodeWorker(worker, options);
  const external = new AbortController(); external.abort();
  const result = await handle.terminate({ timeoutMs: 1000, signal: external.signal });
  assert.equal(result.state, "unconfirmed");
  await handle.exited;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(handle.snapshot().state, "workerTerminated");
  assert.equal(handle.snapshot().tainted, true);
});

test("a natural non-zero exit is stopped but remains a failed, tainted execution", { timeout: 5000 }, async () => {
  const worker = new Worker("process.exit(3)", { eval: true });
  const result = await trackNodeWorker(worker, options).exited;
  assert.equal(result.state, "workerExited");
  assert.equal(result.exitCode, 3);
  assert.equal(result.tainted, true);
  assert.match(result.failures[0]?.message ?? "", /exit code 3/);
});
