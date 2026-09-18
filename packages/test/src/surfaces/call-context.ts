import { types } from "node:util";

import type { SurfaceBackendCall, SurfaceSetupContext } from "./contracts.js";
import { SurfaceProviderError } from "./errors.js";
import { timeout } from "./validation.js";

const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const reasonGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")?.get;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;

export class SurfaceCallContext implements SurfaceBackendCall {
  readonly #context: SurfaceSetupContext;
  readonly #controller = new AbortController();
  readonly #deadlineAt: number;
  readonly #now: () => number;
  readonly #listener: () => void;
  #submitted = false;
  #disposed = false;

  constructor(context: SurfaceSetupContext, requestedTimeoutMs: number | undefined,
    now: () => number = () => performance.now()) {
    assertSignal(context.signal);
    this.#context = context;
    this.#now = now;
    if (!Number.isFinite(context.deadlineAt)) {
      throw new SurfaceProviderError("invalidRequest", "Surface setup deadline must be finite.");
    }
    const requested = timeout(requestedTimeoutMs);
    const startedAt = now();
    this.#deadlineAt = requested === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY : startedAt + requested;
    if (aborted(context.signal)) {
      throw new SurfaceProviderError("aborted", "Surface operation was aborted before submission.");
    }
    if (this.remaining(startedAt) <= 0) {
      throw new SurfaceProviderError("deadline", "No surface operation budget remains.");
    }
    this.#listener = () => this.#controller.abort(reason(context.signal));
    addListener.call(context.signal, "abort", this.#listener, { once: true });
  }

  get signal(): AbortSignal { return this.#controller.signal; }
  get submitted(): boolean { return this.#submitted; }

  beforeSubmit(): { readonly signal: AbortSignal; readonly timeoutMs: number } {
    if (this.#submitted) {
      throw new SurfaceProviderError("invalidBackendReceipt", "Backend submitted an operation more than once.");
    }
    if (aborted(this.signal) || aborted(this.#context.signal)) {
      throw new SurfaceProviderError("aborted", "Surface operation was aborted before submission.");
    }
    const remaining = this.remaining(this.#now());
    if (remaining <= 0) throw new SurfaceProviderError("deadline", "No surface operation budget remains.");
    this.#submitted = true;
    return Object.freeze({ signal: this.signal, timeoutMs: remaining });
  }

  async wait<T>(pending: Promise<T>): Promise<T> {
    if (aborted(this.signal) || aborted(this.#context.signal)) {
      return this.failForStop("aborted", pending);
    }
    const budget = this.remaining(this.#now());
    if (budget <= 0) return this.failForStop("deadline", pending);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(this.stopError("deadline"));
        this.#controller.abort(new Error("surface deadline"));
      }, budget);
      const listener = (): void => reject(this.stopError("aborted"));
      addListener.call(this.signal, "abort", listener, { once: true });
      void pending.then(
        () => removeListener.call(this.signal, "abort", listener),
        () => removeListener.call(this.signal, "abort", listener),
      );
    });
    try {
      const value = await Promise.race([pending, stopped]);
      if (!this.#submitted) {
        throw new SurfaceProviderError("invalidBackendReceipt",
          "Backend resolved without a submission boundary.");
      }
      if (aborted(this.signal) || aborted(this.#context.signal)) throw this.stopError("aborted");
      // A promise can win the same event-loop turn as the timer. The monotonic
      // deadline, not callback queue ordering, is authoritative.
      if (this.remaining(this.#now()) <= 0) throw this.stopError("deadline");
      return value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.dispose();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    removeListener.call(this.#context.signal, "abort", this.#listener);
  }

  private remaining(now: number): number {
    const suppliedRemaining = this.#context.remainingMs();
    if (!Number.isFinite(suppliedRemaining) || suppliedRemaining <= 0) {
      if (!Number.isFinite(suppliedRemaining)) {
        throw new SurfaceProviderError("invalidRequest", "Surface remaining budget must be finite.");
      }
      return 0;
    }
    const setupRemaining = Math.floor(suppliedRemaining);
    const setupDeadlineRemaining = Math.max(0, Math.floor(this.#context.deadlineAt - now));
    const explicit = this.#deadlineAt === Number.POSITIVE_INFINITY
      ? setupRemaining : Math.max(0, Math.floor(this.#deadlineAt - now));
    return Math.min(setupRemaining, setupDeadlineRemaining, explicit, 2_147_483_647);
  }

  private failForStop(kind: "deadline" | "aborted", pending: Promise<unknown>): Promise<never> {
    const primary = this.stopError(kind);
    // The backend already returned this Promise. Observe its eventual result so
    // an immediate caller-side stop cannot leak a detached rejection.
    void pending.catch(() => undefined);
    if (!aborted(this.signal)) this.#controller.abort(primary);
    this.dispose();
    return Promise.reject(primary);
  }

  private stopError(kind: "deadline" | "aborted"): SurfaceProviderError {
    return this.#submitted
      ? new SurfaceProviderError("unknownOutcome",
          `Surface operation ${kind} after backend submission; outcome is unknown.`)
      : new SurfaceProviderError(kind, `Surface operation stopped before backend submission (${kind}).`);
  }
}

function assertSignal(signal: AbortSignal): void {
  if (typeof signal !== "object" || signal === null || types.isProxy(signal)) {
    throw new SurfaceProviderError("aborted", "Surface signal must be a native AbortSignal.");
  }
  try { aborted(signal); reason(signal); }
  catch { throw new SurfaceProviderError("aborted", "Surface signal must be a native AbortSignal."); }
}

function aborted(signal: AbortSignal): boolean {
  if (abortedGetter === undefined) throw new Error("AbortSignal is unavailable.");
  return Boolean(abortedGetter.call(signal));
}

function reason(signal: AbortSignal): unknown {
  return reasonGetter?.call(signal);
}
