export type ExecutionPolicyErrorCode =
  | "invalidInput" | "incompatibleEffectSummary" | "casePlatformUnsupported"
  | "hostUnsupported" | "missingSurface" | "surfaceKindMismatch" | "missingCapability"
  | "effectLimitExceeded" | "undeclaredEffect" | "resourceDenied" | "operationDenied"
  | "boundaryDenied" | "externalEffectDenied" | "securitySensitiveDenied" | "unknownRecoveryDenied";

export class ExecutionPolicyError extends Error {
  override readonly name = "ExecutionPolicyError";
  readonly code: ExecutionPolicyErrorCode;
  readonly phase: "plan" | "preflight" | "authorize";
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: ExecutionPolicyErrorCode,
    phase: ExecutionPolicyError["phase"],
    details: Readonly<Record<string, string>> = {},
  ) {
    super(`Execution policy rejected ${phase}: ${code}.`);
    this.code = code;
    this.phase = phase;
    this.details = Object.freeze({ ...details });
  }
}
