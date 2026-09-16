export const maximumTraceInputBytes = 32 * 1024 * 1024;
export const defaultMaximumEvents = 10_000;
export const hardMaximumEvents = 100_000;

export function resolveMaxEvents(value: number | undefined): number {
  const result = value ?? defaultMaximumEvents;
  if (!Number.isSafeInteger(result) || result < 1 || result > hardMaximumEvents) {
    throw new Error(`maxEvents must be a safe integer between 1 and ${hardMaximumEvents}.`);
  }
  return result;
}

export function recordBudgetFor(maxEvents: number): number {
  return Math.min(hardMaximumEvents, maxEvents * 5 + 1_000);
}
