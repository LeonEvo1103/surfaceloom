import { Worker } from "node:worker_threads";
import { startDeadlineTask } from "./deadline.js";
import type { NodeWorkerHandle, OwnedNodeWorkerOptions, WorkerStopSnapshot } from "./worker-contracts.js";
import { WorkerState } from "./worker-state.js";
import { workerEffects, workerErrorMessage, workerExitCode } from "./worker-validation.js";

/**
 * Tracks a caller-owned, already-created Worker. This does not serialize arbitrary
 * Case closures, fixture values, native handles, or detached external processes.
 * Only the native exit event PLUS matching terminate() fulfillment confirms forced
 * termination. A fulfilled termination promise by itself is insufficient.
 */
export function trackNodeWorker(worker: Worker, options: OwnedNodeWorkerOptions): NodeWorkerHandle {
  if (!(worker instanceof Worker) || worker.threadId < 0) throw new Error("A live Node Worker instance is required.");
  if (options.ownership !== "owned") throw new Error("Only a caller-owned Worker may be terminated.");
  const state = new WorkerState("nodeWorker", workerEffects(options));
  const terminate = worker.terminate.bind(worker);
  let stopping: Promise<WorkerStopSnapshot> | undefined;
  let exitCode: number | null = null;
  let terminationCode: number | null = null;
  let sawError = false;
  let resolveExited!: (snapshot: WorkerStopSnapshot) => void;
  let resolveStop: (() => void) | undefined;
  const exited = new Promise<WorkerStopSnapshot>((resolve) => { resolveExited = resolve; });
  const confirm = () => {
    if (exitCode === null || terminationCode === null) return;
    try { state.confirmTermination(terminationCode); }
    catch { /* The recorder retained an invalid or mismatched receipt. */ }
    resolveStop?.();
  };
  const onError = (error: unknown) => { sawError = true; state.failure("workerError", workerErrorMessage(error)); };
  worker.on("error", onError);
  worker.once("exit", (code) => {
    // This callback is the sole public adapter path that records an exit receipt.
    exitCode = code;
    state.observeExit(code);
    if (code !== 0 && stopping === undefined && !sawError) {
      state.failure("workerError", `Worker exited with non-zero exit code ${code}.`);
    }
    worker.removeListener("error", onError);
    confirm();
    resolveExited(state.snapshot());
  });
  return Object.freeze({ exited, snapshot: () => state.snapshot(),
    markExternalEffectsUnknown: () => state.markExternalEffectsUnknown(),
    terminate: (waitOptions: Parameters<NodeWorkerHandle["terminate"]>[0]) => {
      if (stopping !== undefined) return stopping;
      if (exitCode !== null) { stopping = Promise.resolve(state.snapshot()); return stopping; }
      const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
      // Validate/capture wait options before changing worker state or calling native code.
      const { timeoutMs, clock, signal } = waitOptions;
      const waiter = startDeadlineTask(() => stopped, { timeoutMs,
        ...(clock === undefined ? {} : { clock }), ...(signal === undefined ? {} : { signal }) });
      state.requestStop();
      stopping = waiter.outcome.then((result) => {
        if (result.stopStatus === "unconfirmed" || result.stopStatus === "notStarted") {
          state.unconfirmed("terminationUnconfirmed", "Termination waiting ended without its complete stop receipt.");
        }
        return state.snapshot();
      });
      Promise.resolve().then(terminate).then((code) => {
        try { terminationCode = workerExitCode(code); confirm(); }
        catch (error) {
          state.failure("invalidReceipt", workerErrorMessage(error));
          state.unconfirmed("terminationUnconfirmed", "Termination returned an invalid receipt.");
          resolveStop?.();
        }
      }, (error: unknown) => {
        state.failure("terminationFailed", workerErrorMessage(error));
        state.unconfirmed("terminationUnconfirmed", "Native termination failed; Worker stop is unconfirmed.");
        resolveStop?.();
      });
      return stopping;
    },
  });
}
