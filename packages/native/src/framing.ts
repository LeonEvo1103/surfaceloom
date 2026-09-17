import { maxWireMessageBytes } from "./constants.js";
import type { NativeWireMessage } from "./contracts.js";
import { NativeProtocolError } from "./protocol-error.js";
import { validateWireMessage } from "./schema.js";

/** Parses exactly one UTF-8 NDJSON frame, with an optional final LF/CRLF. */
export function parseWireLine(line: string): NativeWireMessage {
  if (typeof line !== "string") throw new NativeProtocolError("invalid_frame", "Wire frame must be text.");
  // Some line readers strip the delimiter before calling us. Account for the
  // required LF in that form so both transport APIs enforce the same wire cap.
  const wireBytes = Buffer.byteLength(line, "utf8") + (/\r?\n$/u.test(line) ? 0 : 1);
  if (wireBytes > maxWireMessageBytes) {
    throw new NativeProtocolError("message_too_large", "Wire frame exceeds the protocol byte limit.");
  }
  const body = line.endsWith("\r\n") ? line.slice(0, -2) : line.endsWith("\n") ? line.slice(0, -1) : line;
  if (body.length === 0 || /[\r\n]/u.test(body)) {
    throw new NativeProtocolError("invalid_frame", "Wire frame must contain exactly one JSON object.");
  }
  let value: unknown;
  try { value = JSON.parse(body); }
  catch { throw new NativeProtocolError("invalid_json", "Wire frame is not valid JSON."); }
  return validateWireMessage(value);
}

export function encodeWireLine(message: NativeWireMessage): string {
  const checked = validateWireMessage(message);
  const line = `${JSON.stringify(checked)}\n`;
  if (Buffer.byteLength(line, "utf8") > maxWireMessageBytes) {
    throw new NativeProtocolError("message_too_large", "Wire frame exceeds the protocol byte limit.");
  }
  return line;
}
