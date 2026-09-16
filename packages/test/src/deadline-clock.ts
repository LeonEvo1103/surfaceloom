import type { ExecutionClock } from "./deadline-contracts.js";

const maximumTimerDelay = 2_147_483_647;
const systemClock: ExecutionClock = Object.freeze({
  now: () => performance.now(),
  schedule: (callback: () => void, delayMs: number) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
});

export function deadlineDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative.`);
  return value;
}

/** Internal monotonic clock adapter shared by the execution and cancellation budgets. */
export class DeadlineTimer {
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  readonly #read: () => number;
  readonly #schedule: ExecutionClock["schedule"];
  #last: number;
  #failure: Error | null = null;

  constructor(timeoutMs: number, clock: ExecutionClock = systemClock) {
    deadlineDuration(timeoutMs, "timeoutMs");
    this.#read = clock.now.bind(clock);
    this.#schedule = clock.schedule.bind(clock);
    this.#last = this.#read();
    if (!Number.isFinite(this.#last)) throw new Error("Execution clock must return finite milliseconds.");
    this.startedAtMs = this.#last;
    this.deadlineMs = this.#last + timeoutMs;
    if (!Number.isFinite(this.deadlineMs)) throw new Error("Execution deadline exceeds the finite clock range.");
  }

  get currentMs(): number { return this.#last; }

  read(): number {
    if (this.#failure !== null) throw this.#failure;
    try {
      const now = this.#read();
      if (!Number.isFinite(now) || now < this.#last) {
        throw new Error("Execution clock moved backwards or returned a non-finite value.");
      }
      this.#last = now;
      return now;
    } catch {
      this.#failure = new Error("Execution clock failed or moved backwards.");
      throw this.#failure;
    }
  }

  arm(targetMs: number, elapsed: () => void, failed: (error: unknown) => void): () => void {
    let active = true;
    let cancel: (() => void) | undefined;
    const stop = () => {
      active = false;
      // A broken injected scheduler cannot resurrect a closed callback.
      try { cancel?.(); } catch { /* The callback is already logically disabled. */ }
    };
    const fail = (error: unknown) => { stop(); failed(error); };
    const schedule = () => {
      if (!active) return;
      let scheduling = true;
      let firedSynchronously = false;
      try {
        const before = this.read();
        if (before >= targetMs) { stop(); elapsed(); return; }
        cancel = this.#schedule(() => {
          if (!active) return;
          if (scheduling) { firedSynchronously = true; return; }
          try {
            const now = this.read();
            if (now >= targetMs) { stop(); elapsed(); }
            else if (now <= before) {
              this.#failure = new Error("Execution scheduler made no monotonic clock progress.");
              fail(this.#failure);
            } else schedule();
          } catch (error) { fail(error); }
        }, Math.min(targetMs - before, maximumTimerDelay));
        scheduling = false;
        if (typeof cancel !== "function") throw new Error("Execution scheduler must return a cancellation function.");
        if (firedSynchronously) throw new Error("Execution scheduler must invoke callbacks asynchronously.");
      } catch (error) { fail(error); }
    };
    schedule();
    return stop;
  }
}
