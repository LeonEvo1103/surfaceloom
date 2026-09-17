export type SurfaceProviderErrorCode =
  | "aborted"
  | "deadline"
  | "unknownOutcome"
  | "capabilityMismatch"
  | "hostMismatch"
  | "platformMismatch"
  | "wrongOwnership"
  | "invalidBackendReceipt"
  | "invalidRequest";

export class SurfaceProviderError extends Error {
  constructor(readonly code: SurfaceProviderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SurfaceProviderError";
  }
}
