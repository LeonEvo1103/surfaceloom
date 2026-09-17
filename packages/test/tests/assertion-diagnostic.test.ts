import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeTestCase } from "@surfaceloom/reporter";
import { assertObservation } from "../src/assertion.js";
import { attachErrorDiagnostic, errorDiagnostic } from "../src/errors.js";
import { executeCase } from "../src/execute.js";
import { spec, validReport } from "./support.js";

test("standard criterion execution preserves recoverable assertion details in serialized report/v2", async () => {
  let now = 0;
  const report = await executeCase({ spec: spec(), run: async (context) => {
    await context.criterion("verified", () => assertObservation(({ attempt }) => attempt === 1
      ? { state: "available", value: 1, evidenceIds: ["ledger.initial"] }
      : { state: "read-failed", error: { code: "ledgerDisconnected", message: "Ledger disconnected." },
          evidenceIds: ["ledger.failure"] }, {
      expectation: { kind: "value", expected: 2, matches: (value) => value === 2 },
      timeoutMs: 10, pollIntervalMs: 5, criterionId: "verified", evidenceIds: ["run.context"],
      clock: { now: () => now, sleep: async (ms) => { now += ms; } },
    }));
  } }, { platform: "web" });
  const serialized = JSON.parse(JSON.stringify(sanitizeTestCase(report)));
  const step = serialized.result.steps.find((item: { criterionIds?: string[] }) => item.criterionIds?.includes("verified"));
  const diagnostic = JSON.parse(step.diagnostic);
  assert.equal(serialized.result.status, "failed");
  assert.equal(diagnostic.details.schemaVersion, "surfaceloom.error-diagnostic/v1");
  assert.equal(diagnostic.details.kind, "observationAssertion");
  assert.equal(diagnostic.details.truncated, false);
  const details = diagnostic.details.data;
  assert.equal(details.expected, 2);
  assert.equal(details.actual.observation.state, "read-failed");
  assert.equal(details.lastValidObservation.observation.value, 1);
  assert.equal(details.lastReadError.error.code, "ledgerDisconnected");
  assert.equal(details.deadlineMs, 10);
  assert.equal(details.elapsedMs, 10);
  assert.equal(details.attempts, 2);
  assert.equal(details.criterionId, "verified");
  assert.deepEqual(details.evidenceIds, ["run.context", "ledger.initial", "ledger.failure"]);
  validReport(serialized);
});

test("generic attached diagnostics are frozen snapshots and ignore arbitrary Error result getters", () => {
  let getterCalls = 0;
  const error = Object.defineProperty(new Error("original"), "result", {
    get: () => { getterCalls += 1; throw new Error("do not introspect me"); },
  });
  const data = { actual: { count: 1 } };
  attachErrorDiagnostic(error, "generic", data);
  data.actual.count = 99;
  attachErrorDiagnostic(error, "replacement", { actual: "incorrect" });
  const diagnostic = JSON.parse(errorDiagnostic("body", error));
  assert.equal(getterCalls, 0);
  assert.equal(diagnostic.details.kind, "generic");
  assert.deepEqual(diagnostic.details.data, { actual: { count: 1 } });
});

test("attached cyclic, accessor, oversized, and hostile Proxy diagnostics remain bounded and non-throwing", () => {
  let getterCalls = 0;
  const cycle: Record<string, unknown> = { huge: "x".repeat(100_000) };
  cycle.self = cycle;
  Object.defineProperty(cycle, "getter", { enumerable: true, get: () => {
    getterCalls += 1;
    throw new Error("unsafe getter");
  } });
  const hostile = new Proxy({}, { ownKeys: () => { throw new Error("unsafe keys"); } });
  for (const data of [cycle, hostile, Array.from({ length: 10_000 }, () => "x".repeat(2000)),
    { ["x".repeat(300)]: "value" }]) {
    const error = Object.defineProperties(new Error(), {
      message: { get: () => { throw new Error("unsafe message"); } },
      name: { get: () => { throw new Error("unsafe name"); } },
    });
    assert.doesNotThrow(() => attachErrorDiagnostic(error, "hostile", data));
    const diagnostic = errorDiagnostic("body", error);
    assert.ok(Buffer.byteLength(diagnostic) < 64 * 1024);
    const details = JSON.parse(diagnostic).details;
    assert.equal(details.truncated, true);
    if (data === cycle) {
      assert.equal(details.data.self, "[CIRCULAR]");
      assert.equal(details.data.getter, "[UNREADABLE]");
    }
  }
  assert.equal(getterCalls, 0);
});
