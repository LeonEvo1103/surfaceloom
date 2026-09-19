import { startDeadlineTask } from "@surfaceloom/test";
import { createCheckpointController, executorCheckpoints } from "./checkpoints.mjs";
import { startAppendNoteOperation } from "./executor.mjs";
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

export function createRunEngine({ executionClock } = {}) {
  const runs = new Map();
  const effects = [];
  let closed = false;
  let closing;
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

  const engine = {
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
        ledger,
        checkpoints: createCheckpointController(),
        operation: null,
        acceptedOperation: null,
        submitted: false,
        effectApplied: false,
        completed: false,
        stopRequest: null,
        failure: null,
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
      if (run.stopRequest !== null) {
        throw new FixtureError("RUN_STOPPED", "The run no longer accepts a decision", 409);
      }
      run.state.decision = decision;
      const shouldExecute = decision === "approve" || run.state.fault === "deny-but-execute";
      if (!shouldExecute) {
        run.state.status = "denied";
        run.state.ended = true;
        if (run.state.fault !== "incomplete-ledger") run.ledger.finish();
        return view(run);
      }
      run.state.status = decision === "approve" ? "executing" : "denied";
      run.operation = startAppendNoteOperation({
        run,
        ledger: run.ledger,
        effects,
        checkpoints: run.checkpoints,
        engineClosed: () => closed,
        clock: executionClock,
      });
      return view(run);
    },
    readLedger: (runId) => find(runId).ledger.snapshot(),
    readEffects(runId) {
      find(runId);
      return structuredClone(effects.filter((effect) => effect.runId === runId));
    },
    pauseCheckpoint(runId, checkpoint, options) {
      assertOpen();
      return find(runId).checkpoints.pause(checkpoint, options);
    },
    resumeCheckpoint(runId, checkpoint) {
      return find(runId).checkpoints.resume(checkpoint);
    },
    failCheckpoint(runId, checkpoint, message) {
      assertOpen();
      return find(runId).checkpoints.fail(checkpoint, message);
    },
    readCheckpoint(runId, checkpoint) {
      return find(runId).checkpoints.snapshot(checkpoint);
    },
    control(runId, command = {}) {
      if (!executorCheckpoints.includes(command.checkpoint)) {
        throw new FixtureError("INVALID_CHECKPOINT", "A known checkpoint is required");
      }
      if (command.action === "pause") {
        return engine.pauseCheckpoint(runId, command.checkpoint, command);
      }
      if (command.action === "resume") return engine.resumeCheckpoint(runId, command.checkpoint);
      if (command.action === "fail") {
        return engine.failCheckpoint(runId, command.checkpoint, command.message);
      }
      throw new FixtureError("INVALID_CONTROL", "Control action must be pause, resume, or fail");
    },
    stop(runId, { mode = "stop" } = {}) {
      if (mode !== "stop" && mode !== "emergency") {
        throw new FixtureError("INVALID_STOP_MODE", "Stop mode must be stop or emergency");
      }
      const run = find(runId);
      if (run.stopRequest !== null) return run.stopRequest;
      const outcome = run.effectApplied ? "executed" : run.submitted ? "unknown" : "notExecuted";
      const operationSettled = run.operation?.task.snapshot().settlement !== null;
      const cancellationRequested = run.operation !== null && !run.state.ended;
      const receipt = Object.freeze({
        runId,
        mode,
        outcome,
        submitted: run.submitted,
        effectObserved: run.effectApplied,
        settled: run.operation === null || operationSettled,
        cancellationRequested,
      });
      run.stopRequest = receipt;
      if (run.operation === null && !run.state.ended) {
        run.state.status = "cancelled";
        run.state.ended = true;
        if (run.state.fault !== "incomplete-ledger") run.ledger.finish();
      } else if (!run.state.ended) {
        run.state.status = "stopping";
        run.operation.task.cancel(`${mode} requested for ${runId}.`);
      }
      return receipt;
    },
    settle(runId, { timeoutMs = 1_000 } = {}) {
      assertTimeout(timeoutMs);
      const run = find(runId);
      if (run.operation === null) {
        return Promise.resolve(settlementSnapshot(run, run.state.ended));
      }
      if (run.operation.task.snapshot().settlement !== null) {
        return Promise.resolve(settlementSnapshot(run, true));
      }
      const waiter = startDeadlineTask(() => run.operation.task.settled, { timeoutMs });
      return waiter.outcome.then((outcome) => settlementSnapshot(run,
        outcome.status === "settled" && outcome.settlement?.status === "fulfilled"));
    },
    close(options = {}) {
      if (closing !== undefined) return closing;
      const timeoutMs = options?.timeoutMs ?? 1_000;
      let invalidTimeout = null;
      try { assertTimeout(timeoutMs); } catch (error) { invalidTimeout = error; }
      closed = true;
      for (const run of runs.values()) {
        if (!run.state.ended) engine.stop(run.state.runId, { mode: "stop" });
      }
      for (const run of runs.values()) run.checkpoints.releaseForClose();
      if (invalidTimeout !== null) {
        closing = Promise.reject(invalidTimeout);
        return closing;
      }
      const active = [...runs.values()].flatMap((run) => run.operation === null
        || run.operation.task.snapshot().settlement !== null ? [] : [run.operation.task.settled]);
      if (active.length === 0) {
        closing = Promise.resolve();
        return closing;
      }
      const waiter = startDeadlineTask(() => Promise.all(active), { timeoutMs });
      closing = waiter.outcome.then((outcome) => {
        const confirmed = outcome.status === "settled"
          && outcome.settlement?.status === "fulfilled";
        if (!confirmed) {
          throw new FixtureError("CLOSE_UNCONFIRMED",
            "Reference agent work did not confirm settlement before close.", 500);
        }
      });
      return closing;
    },
  };
  return Object.freeze(engine);
}

function settlementSnapshot(run, settled) {
  return Object.freeze({
    runId: run.state.runId,
    status: settled ? "settled" : "unconfirmed",
    settled,
    submitted: run.submitted,
    effectObserved: run.effectApplied,
    run: structuredClone(run.state),
  });
}

function assertTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new FixtureError("INVALID_TIMEOUT", "timeoutMs must be finite and non-negative");
  }
}
