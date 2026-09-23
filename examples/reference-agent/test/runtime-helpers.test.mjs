import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertReadyStatusWithDiagnostic,
  runRuntimeHelpersRecipe,
  waitForReadyStatus,
} from "../recipes/runtime-helpers.mjs";

test("one public recipe observes real file and loopback HTTP status then cleans both fixtures", async () => {
  const result = await runRuntimeHelpersRecipe();

  assert.equal(result.file.status, "passed");
  assert.equal(result.httpJob.status, "passed");
  assert.deepEqual(result.file.assertion.actual.observation.value,
    { source: "file", state: "ready" });
  assert.deepEqual(result.httpJob.assertion.actual.observation.value,
    { source: "loopback-http", state: "ready" });
  assert.deepEqual(result.cleanup, { fileRemoved: true, serverClosed: true });
  await assert.rejects(readFile(result.filePath), { code: "ENOENT" });
  await assert.rejects(fetch(result.jobUrl, { signal: AbortSignal.timeout(500) }));
});

test("a reader that ignores cancellation returns within its total budget", async () => {
  const startedAt = performance.now();
  const result = await waitForReadyStatus(() => new Promise(() => {}), {
    timeoutMs: 40,
    cancellationGraceMs: 30,
    pollIntervalMs: 10,
  });

  assert.equal(result.status, "timedOut");
  assert.equal(result.stopStatus, "unconfirmed");
  assert.equal(result.assertion, null);
  assert.ok(performance.now() - startedAt < 1_000, "hung read must not hang the consumer");
});

test("failed optional diagnostic keeps the original bounded assertion error", async () => {
  let diagnosticPrimaryError;
  const outcome = await assertReadyStatusWithDiagnostic(
    async () => ({ state: "available", value: { state: "pending" } }),
    async (assertionError, { signal, remainingMs }) => {
      diagnosticPrimaryError = assertionError;
      assert.equal(assertionError.name, "BoundedObservationAssertionError");
      assert.equal(signal.aborted, false);
      assert.ok(remainingMs() > 0);
      throw new Error("diagnostic backend unavailable");
    },
    { timeoutMs: 35, pollIntervalMs: 10, cancellationGraceMs: 30,
      diagnosticTimeoutMs: 100 },
  );

  assert.equal(outcome.assertion, null);
  assert.equal(outcome.assertionError.name, "BoundedObservationAssertionError");
  assert.equal(outcome.assertionError, diagnosticPrimaryError);
  assert.equal(outcome.assertionError.result.status, "timedOut");
  assert.equal(outcome.diagnostic.status, "failed");
  assert.match(outcome.diagnostic.failure.message, /diagnostic backend unavailable/u);
});

test("external cancellation reaches the reader and returns a cancelled auxiliary result", async () => {
  const controller = new AbortController();
  let readerSignal;
  const reader = ({ signal }) => new Promise((_resolve, reject) => {
    readerSignal = signal;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const cancel = setTimeout(() => controller.abort(new Error("consumer cancelled")), 20);
  try {
    const result = await waitForReadyStatus(reader, {
      timeoutMs: 1_000,
      cancellationGraceMs: 100,
      signal: controller.signal,
    });
    assert.equal(result.status, "cancelled");
    assert.equal(readerSignal.aborted, true);
    assert.notEqual(result.stopStatus, "unconfirmed");
  } finally {
    clearTimeout(cancel);
  }
});
