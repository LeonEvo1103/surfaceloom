/** Injected schedulers must invoke callbacks asynchronously and return a cancellation function. */
export interface ExecutionClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface DeadlineTaskOptions {
  readonly timeoutMs: number;
  /** Additional bounded wait after cancellation. Defaults to zero. */
  readonly cancellationGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly clock?: ExecutionClock;
}

export interface DeadlineCancellation {
  readonly kind: "deadline" | "external" | "requested" | "clockFailed";
  /** Last confirmed clock sample when the clock itself failed. */
  readonly requestedAtMs: number;
  readonly message: string;
}

export interface DeadlineClockFailure {
  readonly code: "clockFailed";
  readonly message: string;
}

export interface DeadlineTaskContext {
  readonly signal: AbortSignal;
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  remainingMs(): number;
  throwIfCancelled(): void;
  /**
   * A cooperative claim that the callback is responding to cancellation. This is
   * not a stop receipt until the callback's returned promise actually settles.
   */
  acknowledgeCancellation(): boolean;
}

interface SettlementTiming {
  /** Time settlement was observed, not an inferred internal Promise completion time. */
  readonly observedAtMs: number | null;
  readonly cancellation: DeadlineCancellation | null;
}

/** Payloads are borrowed values; only the receipt envelope is frozen. */
export type TaskSettleReceipt<T> = SettlementTiming & (
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "notStarted" }
);

export interface DeadlineTaskSnapshot<T> {
  readonly started: boolean;
  readonly settlement: TaskSettleReceipt<T> | null;
  readonly cancellation: DeadlineCancellation | null;
  readonly cancellationAcknowledged: boolean;
  readonly clockFailure: DeadlineClockFailure | null;
}

export interface DeadlineTaskOutcome<T> extends DeadlineTaskSnapshot<T> {
  readonly status: "settled" | "timedOut" | "cancelled" | "clockFailed";
  /**
   * cooperativeStopped requires acknowledgment AND settlement. All stop states
   * cover only the callback and its returned promise, never detached work.
   */
  readonly stopStatus: "settled" | "cooperativeStopped" | "notStarted" | "unconfirmed";
}

export interface DeadlineTask<T> {
  readonly context: DeadlineTaskContext;
  /** Frozen waiting result; late settlement never rewrites an unconfirmed outcome. */
  readonly outcome: Promise<DeadlineTaskOutcome<T>>;
  /** Never rejects. May stay pending forever for a non-cooperative callback. */
  readonly settled: Promise<TaskSettleReceipt<T>>;
  /** First cancellation wins. Returns null when already settled without cancellation. */
  cancel(message?: string): DeadlineCancellation | null;
  snapshot(): DeadlineTaskSnapshot<T>;
}
