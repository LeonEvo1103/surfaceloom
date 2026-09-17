import { createToolLedger } from "./ledger.mjs";

export const faultModes = Object.freeze(["none", "deny-but-execute", "incomplete-ledger"]);

export class FixtureError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "FixtureError";
    this.code = code;
    this.status = status;
  }
}

function createToolExecutor(ledger, effects) {
  return (runId, callId) => {
    ledger.started(callId);
    effects.push(Object.freeze({ runId, callId, tool: "append-note", value: "approved-note" }));
    ledger.completed(callId);
  };
}

export function createRunEngine() {
  const runs = new Map();
  const effects = [];
  let closed = false;
  let nextId = 1;
  const assertOpen = () => {
    if (closed) throw new FixtureError("FIXTURE_CLOSED", "The fixture is closed", 503);
  };
  const find = (runId) => {
    const run = runs.get(runId);
    if (!run) throw new FixtureError("RUN_NOT_FOUND", "Run not found", 404);
    return run;
  };
  const view = ({ state }) => structuredClone(state);

  return {
    createRun({ fault = "none" } = {}) {
      assertOpen();
      if (!faultModes.includes(fault)) throw new FixtureError("INVALID_FAULT", "Unknown fault mode");
      const ordinal = String(nextId++).padStart(6, "0");
      const runId = `run-${ordinal}`;
      const callId = `${runId}:call-1`;
      const ledger = createToolLedger(runId);
      ledger.requested(callId);
      const run = {
        state: { runId, callId, status: "awaiting-approval", decision: null, ended: false, fault },
        ledger, executeTool: createToolExecutor(ledger, effects),
      };
      runs.set(runId, run);
      return view(run);
    },
    getRun: (runId) => view(find(runId)),
    decide(runId, decision) {
      assertOpen();
      if (decision !== "approve" && decision !== "deny") {
        throw new FixtureError("INVALID_DECISION", "Decision must be approve or deny");
      }
      const run = find(runId);
      if (run.state.decision !== null) {
        if (run.state.decision !== decision) {
          throw new FixtureError("DECISION_CONFLICT", "The run already has a different decision", 409);
        }
        return view(run);
      }
      // Commit the decision before the effect; repeated submissions cannot dispatch it again.
      run.state.decision = decision;
      run.state.status = decision === "approve" ? "executing" : "denied";
      if (decision === "approve" || run.state.fault === "deny-but-execute") {
        run.executeTool(runId, run.state.callId);
      }
      run.state.status = decision === "approve" ? "completed" : "denied";
      run.state.ended = true;
      if (run.state.fault !== "incomplete-ledger") run.ledger.finish();
      return view(run);
    },
    readLedger: (runId) => find(runId).ledger.snapshot(),
    readEffects(runId) {
      find(runId);
      return structuredClone(effects.filter((effect) => effect.runId === runId));
    },
    close() {
      if (closed) return;
      closed = true;
      for (const run of runs.values()) {
        if (!run.state.ended) {
          run.state.status = "cancelled";
          run.state.ended = true;
          if (run.state.fault !== "incomplete-ledger") run.ledger.finish();
        }
      }
    },
  };
}
