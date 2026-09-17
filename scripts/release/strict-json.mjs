const whitespace = /[\u0009\u000a\u000d\u0020]/u;

export class StrictJsonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StrictJsonError";
    this.code = code;
  }
}

export function parseStrictJson(text, { maxDepth = 128 } = {}) {
  if (typeof text !== "string") fail("invalidInput", "Strict JSON input must be text.");
  let offset = 0;
  const skip = () => { while (whitespace.test(text[offset] ?? "")) offset += 1; };
  const parseString = () => {
    const start = offset;
    if (text[offset++] !== '"') fail("invalidString", "Expected a JSON string.");
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        try { return JSON.parse(text.slice(start, offset)); }
        catch { fail("invalidString", "Invalid JSON string escape."); }
      }
      if (code < 0x20) fail("invalidString", "JSON strings cannot contain control bytes.");
      if (code === 0x5c) {
        offset += 1;
        if (offset >= text.length) fail("invalidString", "Truncated JSON escape.");
        if (text[offset] === "u") {
          const escape = text.slice(offset + 1, offset + 5);
          if (!/^[a-fA-F0-9]{4}$/u.test(escape)) fail("invalidString", "Invalid Unicode escape.");
          offset += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(text[offset])) fail("invalidString", "Invalid JSON escape.");
      }
      offset += 1;
    }
    fail("invalidString", "Unterminated JSON string.");
  };
  const parseValue = (depth) => {
    if (depth > maxDepth) fail("tooDeep", "JSON exceeds the maximum nesting depth.");
    skip();
    const token = text[offset];
    if (token === '"') return parseString();
    if (token === "{") return parseObject(depth + 1);
    if (token === "[") return parseArray(depth + 1);
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return value; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(offset));
    if (match === null) fail("invalidToken", `Unexpected JSON token at byte ${offset}.`);
    offset += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) fail("invalidNumber", "JSON number must be finite.");
    return number;
  };
  const parseObject = (depth) => {
    offset += 1;
    skip();
    const output = Object.create(null);
    const seen = new Set();
    if (text[offset] === "}") { offset += 1; return output; }
    while (true) {
      skip();
      const key = parseString();
      if (seen.has(key)) fail("duplicateKey", `Duplicate JSON key: ${key}`);
      seen.add(key);
      skip();
      if (text[offset++] !== ":") fail("invalidObject", "Expected ':' after a JSON key.");
      output[key] = parseValue(depth);
      skip();
      const separator = text[offset++];
      if (separator === "}") return output;
      if (separator !== ",") fail("invalidObject", "Expected ',' or '}' in a JSON object.");
    }
  };
  const parseArray = (depth) => {
    offset += 1;
    skip();
    const output = [];
    if (text[offset] === "]") { offset += 1; return output; }
    while (true) {
      output.push(parseValue(depth));
      skip();
      const separator = text[offset++];
      if (separator === "]") return output;
      if (separator !== ",") fail("invalidArray", "Expected ',' or ']' in a JSON array.");
    }
  };
  const value = parseValue(0);
  skip();
  if (offset !== text.length) fail("trailingData", "Strict JSON has trailing data.");
  return value;
}

function fail(code, message) {
  throw new StrictJsonError(code, message);
}
