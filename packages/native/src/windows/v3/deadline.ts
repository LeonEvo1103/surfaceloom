import { WindowsNativeError } from "../error.js";
import type { WindowsSurfaceSetupContext } from "./contracts.js";

const maximumWireBudgetMs = 120_000;

/** One monotonic budget shared by bootstrap, preflight, and wire submission. */
export class WindowsV3Deadline {
  readonly #deadlineAt: number;

  constructor(readonly context: WindowsSurfaceSetupContext, requestedMs?: number,
    readonly now: () => number = () => performance.now()) {
    const startedAt = now();
    const requested = requestedMs === undefined ? maximumWireBudgetMs
      : Math.min(maximumWireBudgetMs, Math.max(0, Math.floor(requestedMs)));
    const initial = Math.min(requested, caseRemaining(context, startedAt), maximumWireBudgetMs);
    if (initial <= 0) throw new WindowsNativeError("deadline", "Windows v3 surface deadline expired.");
    this.#deadlineAt = startedAt + initial;
  }

  remaining(): number {
    if (this.context.signal.aborted) {
      throw new WindowsNativeError("deadline", "Windows v3 surface was aborted before submission.");
    }
    const current = this.now();
    const value = Math.min(Math.max(0, Math.floor(this.#deadlineAt - current)),
      caseRemaining(this.context, current), maximumWireBudgetMs);
    if (value <= 0) throw new WindowsNativeError("deadline", "Windows v3 surface deadline expired.");
    return value;
  }
}

function caseRemaining(context: WindowsSurfaceSetupContext, current: number): number {
  const supplied = context.remainingMs();
  if (!Number.isFinite(supplied)) {
    throw new WindowsNativeError("deadline", "Windows v3 Case budget must be finite.");
  }
  return Math.max(0, Math.min(Math.floor(supplied), Math.floor(context.deadlineAt - current)));
}
