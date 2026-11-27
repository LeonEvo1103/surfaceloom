import assert from "node:assert/strict";
import test from "node:test";

import type { CaseSpec } from "@surfaceloom/core";

import { assertObservation } from "../src/assertion.js";
import { executeCase, executeCaseWithRunnerContext } from "../src/execute.js";
import type { Observation } from "../src/observation.js";
import { errorSummary } from "../src/errors.js";
import { assertObservationBounded, BoundedObservationAssertionError } from "../src/runtime-helpers.js";
import { spec, validReport } from "./support.js";

function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

function twoCriteriaSpec(): CaseSpec {
  return { ...spec("kernel.readability"), acceptanceCriteria: [
    { id: "tool-count", text: "工具调用次数符合预期。" },
    { id: "effect-count", text: "本地副作用次数符合预期。" },
  ] };
}

function countReader(value: number) {
  return (): Observation<{ count: number }> => ({ state: "available", value: { count: value } });
}

function countExpectation(expected: number) {
  return { kind: "value" as const, expected: { count: expected },
    matches: (value: { count: number }) => value.count === expected };
}

test("a failed observation criterion carries its expected and last observed value into the report",
  async () => {
    const execution = await executeCaseWithRunnerContext({ spec: spec(), run: () => undefined },
      { platform: "web" }, async (context) => {
        await context.criterion("verified", () => assertObservation(countReader(1), {
          expectation: countExpectation(0), timeoutMs: 20, pollIntervalMs: 5,
          clock: fakeClock(), criterionId: "verified" }));
      });
    const { result } = execution.report;
    assert.equal(result.status, "failed");
    assert.equal(execution.failureOrigin, "business");
    assert.equal(result.error?.category, "criterion");
    assert.match(result.error?.message ?? "", /^Observation assertion timedOut after \d+ attempts for criterion verified: /u);
    assert.deepEqual(result.error?.expected, { count: 0 });
    assert.deepEqual(result.error?.actual, { count: 1 });
    validReport(execution.report);
  });

test("with several failed criteria, expected/actual come from the same cause as the message",
  async () => {
    const report = await executeCase({ spec: twoCriteriaSpec(), run: async (context) => {
      const failures = await Promise.allSettled([
        context.criterion("tool-count", () => assertObservation(countReader(1), {
          expectation: countExpectation(0), timeoutMs: 10, pollIntervalMs: 5,
          clock: fakeClock(), criterionId: "tool-count" })),
        context.criterion("effect-count", () => assertObservation(countReader(3), {
          expectation: countExpectation(2), timeoutMs: 10, pollIntervalMs: 5,
          clock: fakeClock(), criterionId: "effect-count" })),
      ]);
      throw new AggregateError(failures.map((item) =>
        item.status === "rejected" ? item.reason : undefined), "Multiple criteria failed.");
    } }, { platform: "web" });
    const error = report.result.error!;
    const criterion = /for criterion ([a-z-]+):/u.exec(error.message)?.[1];
    const pairs: Record<string, unknown> = {
      "tool-count": { expected: { count: 0 }, actual: { count: 1 } },
      "effect-count": { expected: { count: 2 }, actual: { count: 3 } },
    };
    assert.ok(criterion !== undefined && criterion in pairs);
    assert.deepEqual({ expected: error.expected, actual: error.actual }, pairs[criterion]);
    validReport(report);
  });

test("expected/actual are length bounded and describe unusable last reads", async () => {
  const long = "x".repeat(5000);
  const report = await executeCase({ spec: spec(), run: async (context) => {
    await context.criterion("verified", () => assertObservation(
      (): Observation<string> => ({ state: "unknown", reason: "ledger stream truncated" }), {
        expectation: { kind: "value", expected: long, matches: () => false },
        timeoutMs: 10, pollIntervalMs: 5, clock: fakeClock(), criterionId: "verified" }));
  } }, { platform: "web" });
  const { expected, actual } = report.result.error!;
  assert.equal(typeof expected, "string");
  assert.ok((expected as string).length <= 512 + "[TRUNCATED]".length);
  assert.ok((expected as string).startsWith("x".repeat(512)));
  assert.equal(actual, "unknown: ledger stream truncated");
  validReport(report);
});

test("bounded observation failures also expose expected and actual", async () => {
  const report = await executeCase({ spec: spec(), run: async (context) => {
    await context.criterion("verified", () => assertObservationBounded(countReader(4), {
      expectation: countExpectation(5), timeoutMs: 30, pollIntervalMs: 5 }));
  } }, { platform: "web" });
  assert.equal(report.result.status, "failed");
  assert.deepEqual(report.result.error?.expected, { count: 5 });
  assert.deepEqual(report.result.error?.actual, { count: 4 });
});

test("kernel failure steps get a readable title while id and category keep the phase", async () => {
  const report = await executeCase({ spec: spec(), run: () => { throw new Error("boom"); } },
    { platform: "web" });
  const step = report.result.steps.find((item) => item.id.startsWith("kernel.body."));
  assert.ok(step);
  assert.equal(step.title, "Case body");
  assert.match(step.diagnostic ?? "", /"category":"body"/u);
  assert.deepEqual(report.result.error, { category: "body", message: "boom" });
});

test("a bounded deadline keeps the last read completed in time, not a late one", async () => {
  let reads = 0;
  const reader = (context: { readonly signal: AbortSignal }): Promise<Observation<{ count: number }>> => {
    reads += 1;
    if (reads === 1) return Promise.resolve({ state: "available", value: { count: 4 } });
    // Hang until cancelled, then deliver a matching value that arrives too late.
    return new Promise((resolve) => context.signal.addEventListener("abort",
      () => resolve({ state: "available", value: { count: 5 } }), { once: true }));
  };
  const error = await assertObservationBounded(reader, {
    expectation: countExpectation(5), timeoutMs: 40, pollIntervalMs: 5,
  }).then(() => assert.fail("a hung reader must not pass"), (caught: unknown) => caught);
  assert.ok(error instanceof BoundedObservationAssertionError);
  assert.equal(error.result.assertion, null);
  const summary = errorSummary("criterion", error);
  assert.deepEqual(summary.expected, { count: 5 });
  assert.deepEqual(summary.actual, { count: 4 });
});

test("bounded assertions read each observation envelope exactly once", async () => {
  let valueReads = 0;
  const envelope = () => ({ state: "available" as const,
    get value() { valueReads += 1; return { count: 5 }; } });
  await assertObservationBounded(envelope, { expectation: countExpectation(5), timeoutMs: 100,
    pollIntervalMs: 5 });
  assert.equal(valueReads, 1);
});
