export type ProtocolIssueCode = "invalid_frame" | "message_too_large" | "invalid_json"
  | "invalid_message" | "unsupported_protocol" | "unsupported_version"
  | "correlation_mismatch" | "scope_mismatch" | "ownership_required";

export class NativeProtocolError extends Error {
  readonly code: ProtocolIssueCode;

  constructor(code: ProtocolIssueCode, message: string) {
    super(message);
    this.name = "NativeProtocolError";
    this.code = code;
  }
}
