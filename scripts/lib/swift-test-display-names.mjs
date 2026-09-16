import { maskConditionalCompilation } from "./conditional-compilation.mjs";
import {
  activeSwiftEscape,
  skipSwiftOpaque,
  skipSwiftTrivia,
  swiftLineAndColumn,
  swiftSourceError,
  swiftStringPrefix,
} from "./swift-lexical.mjs";

/** Returns static display names from Swift Testing @Test("...") attributes. */
export function extractSwiftTestDisplayNames(source) {
  return scanSwiftTestDisplayNames(source).map((item) => item.name);
}

/** Returns names plus source offsets. Comments and unrelated strings are ignored. */
export function scanSwiftTestDisplayNames(source) {
  if (typeof source !== "string") throw new TypeError("Swift source must be a string.");
  const activeSource = maskConditionalCompilation(source, {
    language: "Swift",
    elseifKeyword: "elseif",
    skipOpaque: skipSwiftOpaque,
  });
  const results = [];
  let index = 0;
  while (index < activeSource.length) {
    const opaqueEnd = skipSwiftOpaque(activeSource, index);
    if (opaqueEnd !== undefined) {
      index = opaqueEnd;
      continue;
    }
    const attributeLength = swiftTestAttributeLength(activeSource, index);
    if (attributeLength !== undefined) {
      let cursor = skipSwiftTrivia(activeSource, index + attributeLength);
      if (activeSource[cursor] !== "(") {
        throw swiftSourceError(
          activeSource,
          index,
          "Every @Test must use parentheses and start with a static display-name string.",
        );
      }
      cursor = skipSwiftTrivia(activeSource, cursor + 1);
      const prefix = swiftStringPrefix(activeSource, cursor);
      if (prefix === undefined) {
        throw swiftSourceError(
          activeSource,
          index,
          "Every @Test must start with a static single-line display-name string.",
        );
      }
      const parsed = parseStaticDisplayName(activeSource, prefix);
      const location = swiftLineAndColumn(activeSource, cursor);
      results.push(Object.freeze({
        name: parsed.value,
        index: cursor,
        line: location.line,
        column: location.column,
      }));
      index = parsed.end;
      continue;
    }
    index += 1;
  }
  return results;
}

function parseStaticDisplayName(source, prefix) {
  if (source.startsWith('"""', prefix.quoteIndex)) {
    throw swiftSourceError(source, prefix.start, "@Test display names must use a single-line string literal.");
  }
  const closingHashes = "#".repeat(prefix.hashCount);
  let cursor = prefix.quoteIndex + 1;
  let value = "";
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\n" || character === "\r") {
      throw swiftSourceError(source, prefix.start, "@Test display name is not terminated on the same line.");
    }
    if (character === '"' && source.startsWith(closingHashes, cursor + 1)) {
      return { value, end: cursor + 1 + prefix.hashCount };
    }
    const escape = activeSwiftEscape(source, cursor, prefix.hashCount);
    if (escape !== undefined) {
      if (escape.character === "(") {
        throw swiftSourceError(source, prefix.start, "@Test display names must not use interpolation.");
      }
      const decoded = decodeEscape(source, escape, prefix.start);
      value += decoded.value;
      cursor = decoded.end;
    } else {
      value += character;
      cursor += 1;
    }
  }
  throw swiftSourceError(source, prefix.start, "@Test display name has an unterminated string literal.");
}

function decodeEscape(source, escape, literalStart) {
  const simple = new Map([
    ["0", "\0"], ["t", "\t"], ["n", "\n"], ["r", "\r"],
    ['"', '"'], ["'", "'"], ["\\", "\\"],
  ]);
  if (simple.has(escape.character)) {
    return { value: simple.get(escape.character), end: escape.characterIndex + 1 };
  }
  if (escape.character === "u" && source[escape.characterIndex + 1] === "{") {
    const closing = source.indexOf("}", escape.characterIndex + 2);
    const scalar = closing === -1 ? "" : source.slice(escape.characterIndex + 2, closing);
    const codePoint = Number.parseInt(scalar, 16);
    if (!/^[0-9A-Fa-f]{1,8}$/u.test(scalar)
        || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw swiftSourceError(source, literalStart, "@Test display name contains an invalid Unicode escape.");
    }
    return { value: String.fromCodePoint(codePoint), end: closing + 1 };
  }
  throw swiftSourceError(
    source,
    literalStart,
    `@Test display name contains unsupported escape \\${escape.character ?? ""}.`,
  );
}

function isIdentifierCharacter(character) {
  return character !== undefined && /[A-Za-z0-9_]/u.test(character);
}

function swiftTestAttributeLength(source, index) {
  for (const attribute of ["@Testing.Test", "@Test"]) {
    if (source.startsWith(attribute, index)
        && !isIdentifierCharacter(source[index + attribute.length])) {
      return attribute.length;
    }
  }
  return undefined;
}
