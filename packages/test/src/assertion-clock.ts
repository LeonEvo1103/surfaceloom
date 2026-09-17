import type { AssertionClock } from "./assertion-contracts.js";

const systemClock: AssertionClock = Object.freeze({
  now: () => performance.now(),
  sleep: (durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)),
});

export class AssertionTimer {
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly #read: () => number;
  readonly #sleep: (durationMs: number) => Promise<void>;
  #last: number;

  constructor(timeoutMs: number, pollIntervalMs = 50, clock: AssertionClock = systemClock) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Assertion timeoutMs must be finite and non-negative.");
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new Error("Assertion pollIntervalMs must be finite and positive.");
    this.#read = clock.now.bind(clock);
    this.#sleep = clock.sleep.bind(clock);
    this.#last = this.#read();
    if (!Number.isFinite(this.#last)) throw new Error("The assertion clock must return finite monotonic milliseconds.");
    this.startedAtMs = this.#last;
    this.deadlineMs = this.#last + timeoutMs;
    if (!Number.isFinite(this.deadlineMs)) throw new Error("Assertion deadline exceeds the finite clock range.");
    this.pollIntervalMs = pollIntervalMs;
  }

  get currentMs(): number { return this.#last; }

  read(): number {
    const now = this.#read();
    if (!Number.isFinite(now) || now < this.#last) throw new Error("The assertion clock moved backwards or returned an invalid value.");
    this.#last = now;
    return now;
  }

  async pause(): Promise<void> {
    const before = this.#last;
    const remaining = this.deadlineMs - before;
    if (remaining <= 0) return;
    await this.#sleep(Math.min(this.pollIntervalMs, remaining));
    if (this.read() <= before) throw new Error("The assertion sleeper did not advance the monotonic clock.");
  }
}
