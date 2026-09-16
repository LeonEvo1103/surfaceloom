import type { DeadlineTask } from "./deadline-contracts.js";
import type { InProcessWorkerHandle, WorkerTrackingOptions } from "./worker-contracts.js";
import { WorkerState } from "./worker-state.js";
import { workerEffects } from "./worker-validation.js";

/**
 * SL-P1-053: track the existing closure/fixture execution without claiming isolation.
 * Cooperative stop covers only the callback promise, never detached JavaScript.
 */
export function trackInProcessTask<T>(task: DeadlineTask<T>, options: WorkerTrackingOptions): InProcessWorkerHandle {
  const state = new WorkerState("inProcess", workerEffects(options));
  const observe = () => {
    const current = task.snapshot();
    if (current.cancellation !== null && current.started) state.requestStop();
    if (current.settlement !== null) state.acceptSettlement(current.settlement, current.cancellationAcknowledged);
  };
  observe();
  const outcome = task.outcome.then((result) => {
    observe();
    if (result.stopStatus === "unconfirmed") {
      state.unconfirmed("stopUnconfirmed", "Waiting ended without confirmation that the in-process callback stopped.");
    }
    return state.snapshot();
  });
  const settled = task.settled.then(() => { observe(); return state.snapshot(); });
  return Object.freeze({ outcome, settled,
    snapshot: () => { observe(); return state.snapshot(); },
    cancel: (message?: string) => { task.cancel(message); observe(); return state.snapshot(); },
    markExternalEffectsUnknown: () => state.markExternalEffectsUnknown(),
  });
}
