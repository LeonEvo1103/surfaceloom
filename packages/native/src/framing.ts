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
  rejectDuplicateObjectKeys(body);
  let value: unknown;
  try { value = JSON.parse(body); }
  catch { throw new NativeProtocolError("invalid_json", "Wire frame is not valid JSON."); }
  return validateWireMessage(value);
}

export function encodeWireLine(message: NativeWireMessage): string {
  const checked = validateWireMessage(message);
  assertValidUnicodeScalars(checked);
  const line = `${JSON.stringify(checked)}\n`;
  if (Buffer.byteLength(line, "utf8") > maxWireMessageBytes) {
    throw new NativeProtocolError("message_too_large", "Wire frame exceeds the protocol byte limit.");
  }
  return line;
}

/** JSON strings are Unicode scalar sequences; UTF-16 surrogate halves may not stand alone. */
function assertValidUnicodeScalars(value: unknown): void {
  const assertString = (text: string): void => {
    for (let offset = 0; offset < text.length; offset += 1) {
      const first = text.charCodeAt(offset);
      if (first >= 0xD800 && first <= 0xDBFF) {
        const second = text.charCodeAt(offset + 1);
        if (!(second >= 0xDC00 && second <= 0xDFFF)) {
          throw new NativeProtocolError("invalid_message", "Wire message contains an unpaired surrogate.");
        }
        offset += 1;
      } else if (first >= 0xDC00 && first <= 0xDFFF) {
        throw new NativeProtocolError("invalid_message", "Wire message contains an unpaired surrogate.");
      }
    }
  };
  if (typeof value === "string") { assertString(value); return; }
  if (Array.isArray(value)) { value.forEach(assertValidUnicodeScalars); return; }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertString(key);
      assertValidUnicodeScalars(item);
    }
  }
}

/** JSON.parse keeps only the last duplicate member, so inspect the source before parsing. */
function rejectDuplicateObjectKeys(source: string): void {
  let offset = 0;
  const literalPattern = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/uy;
  const invalidJson = (message = "Wire frame is not valid JSON."): never => {
    throw new NativeProtocolError("invalid_json", message);
  };
  const whitespace = (): void => {
    while (offset < source.length && /[\u0009\u0020]/u.test(source[offset] ?? "")) offset += 1;
  };
  const stringToken = (): string => {
    const start = offset;
    if (source[offset] !== '"') return invalidJson();
    offset += 1;
    while (offset < source.length) {
      const character = source[offset];
      if (character === '"') {
        offset += 1;
        try { return JSON.parse(source.slice(start, offset)) as string; }
        catch { return invalidJson(); }
      }
      if (character === "\\") {
        offset += 1;
        const escape = source[offset];
        if (escape === "u") {
          const firstDigits = source.slice(offset + 1, offset + 5);
          if (!/^[0-9A-Fa-f]{4}$/u.test(firstDigits)) return invalidJson();
          const first = Number.parseInt(firstDigits, 16);
          offset += 5;
          if (first >= 0xD800 && first <= 0xDBFF) {
            if (source[offset] !== "\\" || source[offset + 1] !== "u") return invalidJson();
            const secondDigits = source.slice(offset + 2, offset + 6);
            if (!/^[0-9A-Fa-f]{4}$/u.test(secondDigits)) return invalidJson();
            const second = Number.parseInt(secondDigits, 16);
            if (second < 0xDC00 || second > 0xDFFF) return invalidJson();
            offset += 6;
          } else if (first >= 0xDC00 && first <= 0xDFFF) {
            return invalidJson();
          }
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) return invalidJson();
        offset += 1;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) return invalidJson();
      const codeUnit = character.charCodeAt(0);
      if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
        const second = source.charCodeAt(offset + 1);
        if (!(second >= 0xDC00 && second <= 0xDFFF)) return invalidJson();
        offset += 2;
      } else {
        if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) return invalidJson();
        offset += 1;
      }
    }
    return invalidJson();
  };
  const value = (depth: number): void => {
    whitespace();
    const character = source[offset];
    // depth is the number of open containers. A 64th container may be empty or
    // contain a scalar, but opening a 65th container is always invalid JSON.
    if (character === "{") {
      if (depth >= 64) return invalidJson("Wire frame exceeds the JSON nesting limit.");
      object(depth + 1);
      return;
    }
    if (character === "[") {
      if (depth >= 64) return invalidJson("Wire frame exceeds the JSON nesting limit.");
      array(depth + 1);
      return;
    }
    if (character === '"') { stringToken(); return; }
    literalPattern.lastIndex = offset;
    const literal = literalPattern.exec(source)?.[0];
    if (literal === undefined) return invalidJson();
    offset += literal.length;
  };
  const object = (depth: number): void => {
    offset += 1;
    whitespace();
    if (source[offset] === "}") { offset += 1; return; }
    const keys = new Set<string>();
    while (offset < source.length) {
      const key = stringToken();
      if (keys.has(key)) return invalidJson("Wire frame contains a duplicate object key.");
      keys.add(key);
      whitespace();
      if (source[offset] !== ":") return invalidJson();
      offset += 1;
      value(depth);
      whitespace();
      if (source[offset] === "}") { offset += 1; return; }
      if (source[offset] !== ",") return invalidJson();
      offset += 1;
      whitespace();
    }
    return invalidJson();
  };
  const array = (depth: number): void => {
    offset += 1;
    whitespace();
    if (source[offset] === "]") { offset += 1; return; }
    while (offset < source.length) {
      value(depth);
      whitespace();
      if (source[offset] === "]") { offset += 1; return; }
      if (source[offset] !== ",") return invalidJson();
      offset += 1;
    }
    return invalidJson();
  };
  value(0);
  whitespace();
  if (offset !== source.length) invalidJson();
}
