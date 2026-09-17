/** A provider's explicit receipt, not proof that arbitrary JavaScript has stopped. */
export type ResourceCleanupReceipt =
  | { readonly status: "released" }
  | { readonly status: "unconfirmed"; readonly reason: string };

export type ResourceRegistration =
  | {
    readonly id: string;
    readonly ownership: "owned";
    /**
     * Must confirm release; fulfillment with undefined is not confirmation.
     * Use an ordinary native Promise. Hostile constructor/species can prevent
     * installing any rejection observer and require a worker isolation boundary.
     */
    readonly cleanup: () => ResourceCleanupReceipt | Promise<ResourceCleanupReceipt>;
  }
  | { readonly id: string; readonly ownership: "borrowed"; readonly cleanup?: never };

export interface ResourceScopeOptions {
  /** Per-resource receipt wait budget, not a cancellation or termination guarantee. */
  readonly cleanupTimeoutMs?: number;
  /** Runner-owned absolute monotonic deadline for the whole cleanup phase. */
  readonly cleanupDeadlineAt?: number;
}

export interface ResourceCleanupBoundary {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

export type ResourceFailureCode = "executionFailed" | "invalidRegistration" | "duplicateResource"
  | "scopeClosed" | "cleanupFailed" | "cleanupUnconfirmed" | "cleanupTimedOut"
  | "invalidCleanupReceipt";

export interface ResourceFailure {
  readonly phase: string;
  readonly code: ResourceFailureCode;
  readonly message: string;
  readonly resourceId?: string;
}

export type ResourceCleanupOutcome =
  | { readonly id: string; readonly ownership: "borrowed"; readonly status: "borrowed" }
  | { readonly id: string; readonly ownership: "owned"; readonly status: "released" }
  | {
    readonly id: string;
    readonly ownership: "owned";
    readonly status: "failed" | "unconfirmed";
    readonly failure: ResourceFailure;
  };

export interface ResourceCleanupRemaining {
  readonly id: string;
  readonly ownership: ResourceRegistration["ownership"];
}

export interface ResourceCleanupResult {
  readonly state: "open" | "closing" | "closed";
  readonly status: "pending" | "passed" | "failed";
  /** Sticky: some resource's release or ownership could not be confirmed. */
  readonly tainted: boolean;
  /** In reverse registration order, including borrowed entries. */
  readonly outcomes: readonly ResourceCleanupOutcome[];
  /** Accepted resources without an outcome yet, in next-cleanup order. */
  readonly remaining: readonly ResourceCleanupRemaining[];
  /** Chronological; a body/setup failure recorded before close stays first. */
  readonly failures: readonly ResourceFailure[];
  readonly primaryFailure?: ResourceFailure;
}
