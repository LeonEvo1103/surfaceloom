import assert from "node:assert/strict";
import test from "node:test";
import { createToolLedger, inspectToolCalls, LedgerIncompleteError } from "../src/ledger.mjs";

const completedLedger = () => {
  const ledger = createToolLedger("run-000001");
  ledger.requested("call-1");
  ledger.started("call-1");
  ledger.completed("call-1");
  ledger.finish();
  return ledger.snapshot();
};

test("a forged empty open snapshot is unknown rather than zero", () => {
  assert.throws(() => inspectToolCalls({
    schema: "reference-tool-ledger/v1", runId: "run-000001",
    events: [], complete: false, endBoundary: null,
  }), LedgerIncompleteError);
});

test("closed snapshots reject truncation, gaps, wrong identity, and lifecycle corruption", () => {
  const corruptions = [
    (snapshot) => { snapshot.events.pop(); },
    (snapshot) => { snapshot.events[1].sequence = 4; },
    (snapshot) => { snapshot.events[1].runId = "another-run"; },
    (snapshot) => { snapshot.events[2].phase = "started"; },
    (snapshot) => { snapshot.events[1].callId = "another-call"; },
    (snapshot) => { snapshot.endBoundary.runId = "another-run"; },
    (snapshot) => { snapshot.endBoundary.lastSequence = 0; },
    (snapshot) => { snapshot.complete = false; },
    (snapshot) => { snapshot.complete = "true"; },
    (snapshot) => { snapshot.events.pop(); snapshot.endBoundary.lastSequence = 2; },
    (snapshot) => {
      snapshot.events.push({ runId: snapshot.runId, callId: "call-1", sequence: 4, tool: "append-note" });
      snapshot.endBoundary.lastSequence = 4;
    },
  ];
  for (const corrupt of corruptions) {
    const snapshot = completedLedger();
    corrupt(snapshot);
    assert.throws(() => inspectToolCalls(snapshot), LedgerIncompleteError);
  }
});

test("the completion barrier freezes the event interval", () => {
  const ledger = createToolLedger("run-000001");
  ledger.requested("call-1");
  ledger.finish();
  ledger.finish();
  assert.equal(inspectToolCalls(ledger.snapshot()).started, 0);
  assert.throws(() => ledger.started("call-1"), /completion barrier/);
  assert.equal(inspectToolCalls(ledger.snapshot()).started, 0);
});
