import type { EffectDescriptor } from "./effects.js";
import type { ExecutionPolicyGate } from "./policy.js";
import type { ExecutionRecorder } from "./recorder.js";

/** Tracks every framework-authorized action, including promises ignored by Case code. */
export class ExecutionDispatchDrain {
  readonly #pending = new Set<Promise<unknown>>();
  readonly #recorder: ExecutionRecorder;

  constructor(recorder: ExecutionRecorder) {
    this.#recorder = recorder;
  }

  dispatch<T>(gate: ExecutionPolicyGate, effect: EffectDescriptor,
    action: (authorized: Readonly<EffectDescriptor>) => T | Promise<T>): Promise<T> {
    const promise = gate.dispatch(effect, action);
    this.#pending.add(promise);
    void promise.then(
      () => { this.#pending.delete(promise); },
      (error: unknown) => {
        this.#pending.delete(promise);
        this.#recorder.failure("effectDispatch", error);
      },
    );
    return promise;
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }
}
