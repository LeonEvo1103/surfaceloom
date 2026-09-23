import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { captureBoundedDiagnostic } from "../src/runtime-helpers.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("successful capture exposes the payload and callback budget", async () => {
  const result = await captureBoundedDiagnostic(({ signal, remainingMs }) => {
    assert.equal(signal.aborted, false);
    assert.ok(remainingMs() > 0 && remainingMs() <= 100);
    return Uint8Array.from([1, 2, 3]);
  }, { timeoutMs: 100 });
  assert.equal(result.status, "captured");
  assert.equal(result.stopStatus, "settled");
  if (result.status === "captured") assert.deepEqual([...result.payload], [1, 2, 3]);
});

test("ordinary callback failure is returned with the original cause", async () => {
  const original = new Error("primary diagnostic failure");
  const result = await captureBoundedDiagnostic(() => { throw original; }, { timeoutMs: 100 });
  assert.equal(result.status, "failed");
  assert.equal(result.stopStatus, "settled");
  assert.equal(Object.hasOwn(result, "payload"), false);
  if (result.status === "failed") {
    assert.equal(result.cause, original);
    assert.equal(result.failure.code, "diagnosticFailed");
    assert.equal(result.failure.message, original.message);
  }
});

test("hung diagnostic returns timedOut without claiming stop or payload", { timeout: 1000 }, async () => {
  const result = await captureBoundedDiagnostic(() => new Promise<never>(() => {}), { timeoutMs: 15 });
  assert.equal(result.status, "timedOut");
  assert.equal(result.stopStatus, "unconfirmed");
  assert.equal(result.cancellation?.kind, "deadline");
  assert.equal(Object.hasOwn(result, "payload"), false);
});

test("late rejection cannot replace the returned timeout", { timeout: 1000 }, async () => {
  const capture = deferred<string>();
  const result = await captureBoundedDiagnostic(() => capture.promise, { timeoutMs: 15 });
  capture.reject(new Error("late capture failure"));
  await nextTurn();
  assert.equal(result.status, "timedOut");
  assert.equal(result.stopStatus, "unconfirmed");
  assert.equal(Object.hasOwn(result, "payload"), false);
});

test("external cancellation can be confirmed only after callback settlement", { timeout: 1000 }, async () => {
  const external = new AbortController();
  const waiting = captureBoundedDiagnostic(({ signal }) => new Promise<string>((resolve) => {
    signal.addEventListener("abort", () => resolve("discarded late payload"), { once: true });
  }), { timeoutMs: 200, cancellationGraceMs: 50, signal: external.signal });
  external.abort();
  const result = await waiting;
  assert.equal(result.status, "cancelled");
  assert.equal(result.stopStatus, "cooperativeStopped");
  assert.equal(result.cancellationAcknowledged, true);
  assert.equal(Object.hasOwn(result, "payload"), false);
});

test("zero-budget capture does not invoke the callback", async () => {
  const result = await captureBoundedDiagnostic(() => assert.fail("callback started"), { timeoutMs: 0 });
  assert.equal(result.status, "timedOut");
  assert.equal(result.stopStatus, "notStarted");
  assert.equal(result.started, false);
  assert.equal(Object.hasOwn(result, "payload"), false);
});
