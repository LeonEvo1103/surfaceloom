import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProcessExitReceipt } from "./types.js";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Returns true only when the process-close signal won the grace race. */
export async function waitForCloseOrGrace(closed: Promise<void>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const winner = await Promise.race([closed.then(() => true), new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), graceMs);
  })]);
  if (timer !== undefined) clearTimeout(timer);
  return winner;
}

export class ExitReceiptTracker {
  readonly #result = deferred<ProcessExitReceipt>();
  #value: ProcessExitReceipt | null = null;

  get value(): ProcessExitReceipt | null { return this.#value; }
  wait(): Promise<ProcessExitReceipt> { return this.#result.promise; }

  settle(receipt: ProcessExitReceipt): void {
    if (this.#value !== null) return;
    this.#value = receipt;
    this.#result.resolve(receipt);
  }
}

export class OneShotDeadline {
  readonly #milliseconds: number;
  readonly #expired: () => void;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(milliseconds: number, expired: () => void) {
    this.#milliseconds = milliseconds;
    this.#expired = expired;
  }

  arm(): void {
    if (this.#milliseconds === 0) { this.#expired(); return; }
    this.#timer = setTimeout(this.#expired, this.#milliseconds);
  }

  cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

export async function shutdownOwnedChild(child: ChildProcessWithoutNullStreams,
  closed: Promise<void>, isClosed: () => boolean, graceMs: number, forceMs: number): Promise<boolean> {
  if (!child.stdin.destroyed && !child.stdin.writableEnded) {
    try { child.stdin.end(); } catch { /* Continue to owned-process termination. */ }
  }
  if (!isClosed()) await waitForCloseOrGrace(closed, graceMs);
  if (!isClosed()) {
    try { child.kill("SIGKILL"); } catch { /* A kill call is not an exit receipt. */ }
    await waitForCloseOrGrace(closed, forceMs);
  }
  return isClosed();
}
