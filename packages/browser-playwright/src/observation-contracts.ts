export type BrowserObservationKind =
  | "consoleMessage"
  | "pageError"
  | "requestStarted"
  | "requestFinished"
  | "requestFailed"
  | "response";

export interface BrowserObservation {
  readonly kind: BrowserObservationKind;
  /** ISO-8601. Lets a caller derive pending-request duration without Playwright objects. */
  readonly at: string;
  /**
   * Session-scoped identity of the underlying request, set on every request lifecycle
   * observation (`requestStarted` / `requestFinished` / `requestFailed` / `response`).
   * Playwright dispatches the same Request instance to `request`, `requestfinished` and
   * `requestfailed`, and `response.request()` returns that same instance, so this pairs
   * concurrent or retried calls to one endpoint — which `method + url` cannot: with three
   * in-flight attempts and one completion, a `method + url` key reports all three settled
   * and the hung attempts vanish from the pending set.
   */
  readonly requestId?: number;
  readonly url?: string;
  readonly method?: string;
  readonly status?: number;
  /** Console level, passed through unchanged; the caller decides which levels matter. */
  readonly level?: string;
  readonly text?: string;
  /** Raw net::ERR_* style failure text. */
  readonly failure?: string;
  /** Observations can carry credentials, page text or user data. */
  readonly sensitive: true;
}

/** Default retention for a subscription that does not pick its own `limit`. */
export const defaultObservationLimit = 5_000;

export interface BrowserObservationOptions {
  /**
   * Maximum observations retained by this subscription. The oldest entries are discarded
   * first and counted, so an unattended run cannot grow the stream without bound.
   */
  readonly limit?: number;
}

export interface BrowserObservationBatch {
  /** Retained observations in arrival order, oldest first. */
  readonly observations: readonly BrowserObservation[];
  /**
   * Observations discarded because `limit` was reached. A truncated stream is never
   * silent: a caller reading `dropped > 0` knows the stream is not the whole story.
   */
  readonly dropped: number;
}

export interface BrowserObservationHandle {
  /** Stops subscribing and returns the retained observations plus the discard count. Idempotent. */
  stop(): BrowserObservationBatch;
}
