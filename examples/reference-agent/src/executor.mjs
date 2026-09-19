import { startDeadlineTask } from "@surfaceloom/test";

const defaultOperationTimeoutMs = 60_000;

export function startAppendNoteOperation({
  run, ledger, effects, checkpoints, engineClosed, clock,
}) {
  const record = { task: null, accepted: false };

  const task = startDeadlineTask((context) => execute(context), {
    timeoutMs: defaultOperationTimeoutMs,
    ...(clock === undefined ? {} : { clock }),
  });
  record.task = task;
  return record;

  function execute(context) {
    let phase = "before-submit";
    const advance = () => {
      const wait = checkpoints.arrive(phase, context.signal);
      if (wait !== undefined) return wait.then(advanceAfterCheckpoint);
      return advanceAfterCheckpoint();
    };
    const advanceAfterCheckpoint = () => {
      if (phase === "before-submit") {
        if (sampledCancellation(context) || run.stopRequest !== null || engineClosed()) {
          return finishCancelled(false, context);
        }
        // Submission is one synchronous boundary: no await or user callback may split it.
        run.submitted = true;
        ledger.started(run.state.callId);
        record.accepted = true;
        run.acceptedOperation = record;
        phase = "after-submit";
        return advance();
      }
      if (phase === "after-submit") {
        if (sampledCancellation(context) || run.stopRequest !== null || engineClosed()) {
          return finishCancelled(true, context);
        }
        effects.push(Object.freeze({
          runId: run.state.runId,
          callId: run.state.callId,
          tool: "append-note",
          value: "approved-note",
        }));
        run.effectApplied = true;
        phase = "after-effect";
        return advance();
      }
      // Cancellation after the effect cannot roll it back or erase its lifecycle tail.
      sampledCancellation(context);
      ledger.completed(run.state.callId);
      run.completed = true;
      return finishCompleted();
    };
    try {
      const result = advance();
      return isThenable(result) ? Promise.resolve(result).catch(finishFailed) : result;
    } catch (error) {
      return finishFailed(error);
    }
  }

  function finishCancelled(submitted, context) {
    context.acknowledgeCancellation();
    run.state.status = "cancelled";
    run.state.ended = true;
    if (!submitted && run.state.fault !== "incomplete-ledger") ledger.finish();
    return Object.freeze({ outcome: submitted ? "unknown" : "notExecuted" });
  }

  function finishCompleted() {
    run.state.status = run.state.decision === "approve" ? "completed" : "denied";
    run.state.ended = true;
    if (run.state.fault !== "incomplete-ledger") ledger.finish();
    return Object.freeze({ outcome: "executed" });
  }

  function finishFailed(error) {
    run.failure = error;
    run.state.status = "failed";
    run.state.ended = true;
    if (!run.submitted && run.state.fault !== "incomplete-ledger") ledger.finish();
    throw error;
  }
}

function sampledCancellation(context) {
  context.remainingMs();
  if (!context.signal.aborted) return false;
  context.acknowledgeCancellation();
  return true;
}

function isThenable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function";
}
