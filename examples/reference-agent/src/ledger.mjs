export class LedgerIncompleteError extends Error {
  constructor(message) {
    super(message);
    this.name = "LedgerIncompleteError";
    this.code = "LEDGER_INCOMPLETE";
  }
}

// The executor writes this ledger directly. Agent run status is not an input to counts.
export function createToolLedger(runId) {
  const events = [];
  let endBoundary = null;
  const append = (callId, phase) => {
    if (endBoundary) throw new Error("Cannot append after the ledger completion barrier");
    events.push({ runId, callId, phase, sequence: events.length + 1, tool: "append-note" });
  };
  return {
    requested: (callId) => append(callId, "requested"),
    started: (callId) => append(callId, "started"),
    completed: (callId) => append(callId, "completed"),
    finish() {
      endBoundary ??= { runId, kind: "run-ended", lastSequence: events.length };
    },
    snapshot() {
      return structuredClone({
        schema: "reference-tool-ledger/v1", runId, events,
        complete: endBoundary !== null, endBoundary,
      });
    },
  };
}

/** Count only closed, contiguous observations. An empty open snapshot is unknown. */
export function inspectToolCalls(snapshot, expectedRunId = snapshot?.runId) {
  const fail = (message) => { throw new LedgerIncompleteError(message); };
  if (!snapshot || snapshot.schema !== "reference-tool-ledger/v1"
      || typeof expectedRunId !== "string" || snapshot.runId !== expectedRunId) {
    fail("Ledger identity or schema does not match the requested run");
  }
  const { events, endBoundary } = snapshot;
  if (snapshot.complete !== true || !endBoundary || endBoundary.kind !== "run-ended"
      || endBoundary.runId !== expectedRunId || !Array.isArray(events)
      || endBoundary.lastSequence !== events.length) {
    fail("A complete run boundary and its entire event interval are required");
  }
  const calls = new Map();
  for (const [index, event] of events.entries()) {
    if (!event || event.sequence !== index + 1 || event.runId !== expectedRunId
        || typeof event.callId !== "string" || !event.callId || event.tool !== "append-note") {
      fail("The observed ledger interval has a gap or invalid event");
    }
    const phases = calls.get(event.callId) ?? [];
    if (phases.length >= 3 || event.phase !== ["requested", "started", "completed"][phases.length]) {
      fail("Tool lifecycle is incomplete, duplicated, or out of order");
    }
    phases.push(event.phase);
    calls.set(event.callId, phases);
  }
  if ([...calls.values()].some((phases) => phases.length === 2)) {
    fail("A started tool has no completion at the run boundary");
  }
  return Object.freeze({
    runId: expectedRunId,
    requested: calls.size,
    started: [...calls.values()].filter((phases) => phases.length === 3).length,
    completed: [...calls.values()].filter((phases) => phases.length === 3).length,
    complete: true,
  });
}
