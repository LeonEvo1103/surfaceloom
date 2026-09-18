import { WindowsNativeError } from "./error.js";
import { timeout } from "./validation.js";

export class WindowsDeadline {
  readonly #deadlineAt: number;
  constructor(timeoutMs: number | undefined, readonly signal: AbortSignal | undefined,
    readonly now: () => number = () => performance.now()) {
    this.#deadlineAt = now() + timeout(timeoutMs);
    this.remaining();
  }

  remaining(): number {
    if (this.signal?.aborted === true) {
      throw new WindowsNativeError("deadline", "Windows native operation was aborted before submission.");
    }
    const remaining = Math.max(0, Math.floor(this.#deadlineAt - this.now()));
    if (remaining <= 0) throw new WindowsNativeError("deadline", "Windows native operation deadline expired.");
    return remaining;
  }
}
