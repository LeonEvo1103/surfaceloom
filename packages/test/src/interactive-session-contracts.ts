export const INTERACTIVE_SESSION_LEASE_SCHEMA = "surfaceloom.interactive-session-lease/1";

export interface AcquireInteractiveSessionLeaseOptions {
  /** Caller-owned absolute directory. No process-global lock directory is implied. */
  readonly directory: string;
  readonly name?: string;
  readonly timeoutMs?: number;
  readonly retryIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface InteractiveSessionLeaseClaim {
  readonly directory: string;
  readonly name: string;
  readonly pid: number;
  readonly processCreationMarker: string;
  readonly ownerNonce: string;
  readonly leaseToken: string;
  readonly acquiredAt: string;
}

export interface InteractiveSessionReleaseReceipt {
  readonly status: "released";
}

/** Reserved acquisition diagnostics; directory publication currently emits none. */
export interface InteractiveSessionLeaseDiagnostic {
  readonly code: "pendingCleanupRetained";
  readonly message: string;
  readonly artifactPath: string;
}

export interface InteractiveSessionLease extends InteractiveSessionLeaseClaim {
  readonly path: string;
  readonly diagnostics: readonly InteractiveSessionLeaseDiagnostic[];
  release(): Promise<InteractiveSessionReleaseReceipt>;
}

export type InteractiveSessionLeaseErrorCode =
  | "aborted"
  | "corruptLease"
  | "invalidOptions"
  | "notOwner"
  | "processIdentityUnavailable"
  | "timedOut";

export class InteractiveSessionLeaseError extends Error {
  readonly code: InteractiveSessionLeaseErrorCode;

  constructor(code: InteractiveSessionLeaseErrorCode, message: string) {
    super(message);
    this.name = "InteractiveSessionLeaseError";
    this.code = code;
  }
}

export interface InteractiveSessionLeaseMetadata {
  readonly schema: typeof INTERACTIVE_SESSION_LEASE_SCHEMA;
  readonly resource: string;
  readonly pid: number;
  readonly processCreationMarker: string;
  readonly ownerNonce: string;
  readonly leaseToken: string;
  readonly acquiredAt: string;
}
