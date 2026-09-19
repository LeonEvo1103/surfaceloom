import assert from "node:assert/strict";
import test from "node:test";

import { defineCaseSpec } from "@surfaceloom/core";

import { createFaultMatrixCase } from "../fault-matrix/cases.mjs";
import { faultMatrixCases } from "../fault-matrix/matrix.mjs";
import { settleProbeReads } from "../showcase/probe-settlement.mjs";
import { createRunEngine, inspectToolCalls } from "../src/index.mjs";

test("P3-088 fixed matrix has eight independent Chinese CaseSpecs", () => {
  assert.equal(faultMatrixCases.length, 8);
  assert.equal(new Set(faultMatrixCases.map((entry) => entry.id)).size, 8);
  for (const entry of faultMatrixCases) {
    const created = createFaultMatrixCase(entry);
    assert.equal(created.definition.spec.id, entry.id);
    assert.equal(defineCaseSpec(created.definition.spec).locale, "zh-CN");
    assert.ok(created.definition.spec.acceptanceCriteria.length >= 3);
  }
});

test("duplicate effect is injected once inside one accepted operation across two callIds", async () => {
  const engine = createRunEngine();
  const run = engine.createRun({ fault: "duplicate-business-effect" });
  for (let index = 0; index < 8; index += 1) engine.decide(run.runId, "approve");
  assert.equal((await engine.settle(run.runId)).settled, true);
  const ledger = engine.readLedger(run.runId);
  assert.deepEqual(inspectToolCalls(ledger, run.runId), {
    runId: run.runId, requested: 2, started: 2, completed: 2, complete: true,
  });
  assert.deepEqual([...new Set(ledger.events.map((event) => event.callId))],
    [`${run.runId}:call-1`, `${run.runId}:call-2`]);
  const effects = engine.readEffects(run.runId);
  assert.equal(effects.length, 2);
  assert.equal(new Set(effects.map((effect) => effect.logicalOperationId)).size, 1);
  assert.equal(effects[0].logicalOperationId, `${run.runId}:append-note:approved-note`);
  await engine.close();
});

test("missing and truncated faults exist only at detached ledger observation", async () => {
  for (const fault of ["missing-ledger", "truncated-ledger"]) {
    const engine = createRunEngine();
    const run = engine.createRun({ fault });
    engine.decide(run.runId, "approve");
    assert.equal((await engine.settle(run.runId)).settled, true);
    const raw = engine.readRawLedger(run.runId);
    assert.equal(inspectToolCalls(raw, run.runId).completed, 1);
    assert.equal(engine.readEffects(run.runId).length, 1);
    if (fault === "missing-ledger") {
      assert.throws(() => engine.readLedger(run.runId), { code: "LEDGER_READ_FAILED" });
    } else {
      const observed = engine.readLedger(run.runId);
      assert.equal(observed.endBoundary.lastSequence, raw.endBoundary.lastSequence);
      assert.deepEqual(observed.events.map((event) => event.sequence), [1, 2]);
      assert.equal(observed.events.length, 2);
      assert.throws(() => inspectToolCalls(observed, run.runId), { code: "LEDGER_INCOMPLETE" });
    }
    await engine.close();
  }
});

test("a failed evidence reader still waits for all sibling reads and leaves no polling", async () => {
  let active = 0;
  let completed = 0;
  const delayed = () => new Promise((resolve) => {
    active += 1;
    setTimeout(() => { active -= 1; completed += 1; resolve("settled"); }, 15);
  });
  await assert.rejects(settleProbeReads([
    Promise.reject(new Error("ledger read failed")), delayed(), delayed(), delayed(),
  ]), /ledger read failed/u);
  assert.equal(active, 0);
  const atReturn = completed;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(completed, atReturn);
});
