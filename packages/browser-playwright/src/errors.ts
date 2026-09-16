export type BrowserAutomationErrorCode =
  | "ambiguousTarget"
  | "artifactState"
  | "dependencyUnavailable"
  | "invalidArgument"
  | "operationFailed"
  | "sessionClosed"
  | "targetNotFound";

export class BrowserAutomationError extends Error {
  public readonly code: BrowserAutomationErrorCode;

  public constructor(
    code: BrowserAutomationErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BrowserAutomationError";
    this.code = code;
  }
}

export function isBrowserAutomationError(
  error: unknown,
): error is BrowserAutomationError {
  return error instanceof BrowserAutomationError;
}
