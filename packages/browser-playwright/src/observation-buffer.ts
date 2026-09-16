import type { BrowserObservation } from "./contracts.js";
import { defaultObservationLimit } from "./observation-contracts.js";
import { BrowserAutomationError } from "./errors.js";

export function observationLimit(limit: number | undefined): number {
  if (limit === undefined) return defaultObservationLimit;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new BrowserAutomationError(
      "invalidArgument",
      "An observation limit must be a positive integer.",
    );
  }
  return limit;
}

/**
 * Fixed-capacity ring buffer. An unbounded array was fine for a short scripted run and
 * grows without limit under a long canary, so the oldest observations are overwritten and
 * counted instead: the caller sees `dropped > 0` rather than a silently truncated stream.
 */
export class ObservationBuffer {
  private readonly entries: BrowserObservation[] = [];
  private oldest = 0;
  public dropped = 0;

  public constructor(private readonly limit: number) {}

  public push(observation: BrowserObservation): void {
    if (this.entries.length < this.limit) {
      this.entries.push(observation);
      return;
    }
    this.entries[this.oldest] = observation;
    this.oldest = (this.oldest + 1) % this.limit;
    this.dropped += 1;
  }

  public drain(): readonly BrowserObservation[] {
    const ordered = this.entries.length < this.limit
      ? [...this.entries]
      : [...this.entries.slice(this.oldest), ...this.entries.slice(0, this.oldest)];
    return Object.freeze(ordered);
  }
}
