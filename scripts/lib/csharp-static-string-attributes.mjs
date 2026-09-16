import { maskConditionalCompilation } from "./conditional-compilation.mjs";
import { parseCSharpIdentifier } from "./csharp-identifiers.mjs";
import {
  parseMatchingCSharpAttributeTypeName,
  rejectCSharpAttributeTypeAliases,
  rejectCSharpGroupedTargetAttribute,
} from "./csharp-attribute-type-name.mjs";
import {
  csharpLineAndColumn,
  csharpSourceError,
  skipCSharpOpaque,
  skipCSharpBlockComment,
  skipCSharpLineComment,
  skipCSharpTrivia,
  skipUnrelatedCSharpLiteral,
} from "./csharp-lexical.mjs";

/** Returns static positional strings from standalone C# attributes. */
export function extractCSharpStaticStringAttributeNames(source, attributeName) {
  return scanCSharpStaticStringAttributes(source, attributeName).map((item) => item.name);
}

/** Returns attribute strings plus source offsets. Comments and unrelated literals are ignored. */
export function scanCSharpStaticStringAttributes(source, attributeName) {
  if (typeof source !== "string") throw new TypeError("C# source must be a string.");
  requireSimpleAttributeName(attributeName);
  const activeSource = maskConditionalCompilation(source, {
    language: "C#",
    elseifKeyword: "elif",
    skipOpaque: skipCSharpOpaque,
  });
  rejectCSharpAttributeTypeAliases(activeSource, attributeName);
  const results = [];
  let index = 0;
  while (index < activeSource.length) {
    const opaqueEnd = skipCSharpOpaque(activeSource, index);
    if (opaqueEnd !== undefined) {
      index = opaqueEnd;
      continue;
    }
    if (activeSource[index] === "[") {
      const attribute = parseStringAttribute(activeSource, index, attributeName);
      if (attribute !== undefined) {
        results.push(Object.freeze({
          name: attribute.name,
          index: attribute.stringIndex,
          ...csharpLineAndColumn(source, attribute.stringIndex),
        }));
        index = attribute.end;
        continue;
      }
      rejectCSharpGroupedTargetAttribute(activeSource, index, attributeName);
    }
    index += 1;
  }
  return results;
}

function parseStringAttribute(source, start, attributeName) {
  let cursor = skipCSharpTrivia(source, start + 1);
  const typeName = parseMatchingCSharpAttributeTypeName(source, cursor, attributeName);
  if (typeName === undefined) return undefined;
  cursor = typeName.end;
  if (source[cursor] !== "(") {
    throw attributeError(source, start, attributeName, "must use one static positional source-name string");
  }
  cursor = skipCSharpTrivia(source, cursor + 1);
  if (source[cursor] !== '"' || source.startsWith('"""', cursor)) {
    throw attributeError(source, start, attributeName, "must start with a static single-line string");
  }
  const stringIndex = cursor;
  const parsed = parseStaticString(source, cursor, attributeName);
  cursor = skipCSharpTrivia(source, parsed.end);
  if (source[cursor] === ",") {
    cursor = skipNamedAttributeArguments(source, cursor, start, attributeName);
  } else if (source[cursor] === ")") {
    cursor += 1;
  } else {
    throw attributeError(
      source,
      start,
      attributeName,
      "must place a static source-name string before any named arguments",
    );
  }
  cursor = skipCSharpTrivia(source, cursor);
  if (source[cursor] !== "]") {
    throw attributeError(source, start, attributeName, "must be declared as a standalone attribute");
  }
  return { name: parsed.value, stringIndex, end: cursor + 1 };
}

function skipNamedAttributeArguments(source, start, attributeStart, attributeName) {
  let cursor = start;
  while (source[cursor] === ",") {
    cursor = skipCSharpTrivia(source, cursor + 1);
    const property = parseCSharpIdentifier(source, cursor);
    if (property === undefined) {
      throw attributeError(source, attributeStart, attributeName, "arguments after sourceName must be named attribute properties");
    }
    cursor = property.end;
    cursor = skipCSharpTrivia(source, cursor);
    if (source[cursor] !== "=") {
      throw attributeError(source, attributeStart, attributeName, "arguments after sourceName must be named attribute properties");
    }
    cursor = skipCSharpTrivia(source, cursor + 1);
    cursor = skipAttributeArgumentExpression(source, cursor, attributeStart, attributeName);
    cursor = skipCSharpTrivia(source, cursor);
  }
  if (source[cursor] !== ")") {
    throw attributeError(source, attributeStart, attributeName, "attribute is not terminated");
  }
  return cursor + 1;
}

function skipAttributeArgumentExpression(source, start, attributeStart, attributeName) {
  let cursor = start;
  let sawToken = false;
  const depths = { parentheses: 0, brackets: 0, braces: 0 };
  while (cursor < source.length) {
    if (source.startsWith("//", cursor)) {
      cursor = skipCSharpLineComment(source, cursor + 2);
      continue;
    }
    if (source.startsWith("/*", cursor)) {
      cursor = skipCSharpBlockComment(source, cursor);
      continue;
    }
    const literalEnd = skipUnrelatedCSharpLiteral(source, cursor);
    if (literalEnd !== undefined) {
      sawToken = true;
      cursor = literalEnd;
      continue;
    }
    const character = source[cursor];
    if (character === "(") depths.parentheses += 1;
    else if (character === ")") {
      if (depths.parentheses === 0 && depths.brackets === 0 && depths.braces === 0) break;
      depths.parentheses -= 1;
      if (depths.parentheses < 0) break;
    } else if (character === "[") depths.brackets += 1;
    else if (character === "]") depths.brackets -= 1;
    else if (character === "{") depths.braces += 1;
    else if (character === "}") depths.braces -= 1;
    else if (character === ","
        && depths.parentheses === 0 && depths.brackets === 0 && depths.braces === 0) break;
    if (!/\s/u.test(character)) sawToken = true;
    if (depths.brackets < 0 || depths.braces < 0) break;
    cursor += 1;
  }
  if (!sawToken || depths.parentheses !== 0 || depths.brackets !== 0 || depths.braces !== 0) {
    throw attributeError(source, attributeStart, attributeName, "contains an invalid named argument");
  }
  return cursor;
}

function parseStaticString(source, start, attributeName) {
  let cursor = start + 1;
  let value = "";
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\n" || character === "\r") {
      throw attributeError(source, start, attributeName, "source name is not terminated on the same line");
    }
    if (character === '"') return { value, end: cursor + 1 };
    if (character !== "\\") {
      value += character;
      cursor += 1;
      continue;
    }
    const escape = decodeEscape(source, cursor, start, attributeName);
    value += escape.value;
    cursor = escape.end;
  }
  throw attributeError(source, start, attributeName, "source name has an unterminated string literal");
}

function decodeEscape(source, start, literalStart, attributeName) {
  const character = source[start + 1];
  const simple = new Map([
    ["0", "\0"], ["a", "\x07"], ["b", "\b"], ["f", "\f"],
    ["n", "\n"], ["r", "\r"], ["t", "\t"], ["v", "\v"],
    ['"', '"'], ["'", "'"], ["\\", "\\"],
  ]);
  if (simple.has(character)) return { value: simple.get(character), end: start + 2 };
  if (character === "u" || character === "U") {
    const width = character === "u" ? 4 : 8;
    return decodeUnicode(source, start + 2, width, literalStart, attributeName);
  }
  if (character === "x") {
    let end = start + 2;
    while (end < start + 6 && /[0-9A-Fa-f]/u.test(source[end] ?? "")) end += 1;
    if (end === start + 2) {
      throw attributeError(source, literalStart, attributeName, "source name contains an invalid hex escape");
    }
    return unicodeValue(source, source.slice(start + 2, end), end, literalStart, attributeName);
  }
  throw attributeError(
    source,
    literalStart,
    attributeName,
    `source name contains unsupported escape \\${character ?? ""}`,
  );
}

function decodeUnicode(source, start, width, literalStart, attributeName) {
  const scalar = source.slice(start, start + width);
  if (scalar.length !== width || !/^[0-9A-Fa-f]+$/u.test(scalar)) {
    throw attributeError(source, literalStart, attributeName, "source name contains an invalid Unicode escape");
  }
  return unicodeValue(source, scalar, start + width, literalStart, attributeName);
}

function unicodeValue(source, scalar, end, literalStart, attributeName) {
  const codePoint = Number.parseInt(scalar, 16);
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    throw attributeError(source, literalStart, attributeName, "source name contains an invalid Unicode scalar");
  }
  return { value: String.fromCodePoint(codePoint), end };
}

function requireSimpleAttributeName(attributeName) {
  if (typeof attributeName !== "string" || !/^@?[A-Za-z_][A-Za-z0-9_]*$/u.test(attributeName)) {
    throw new TypeError("C# case attribute name must be one unqualified static identifier.");
  }
}

function attributeError(source, index, attributeName, message) {
  return csharpSourceError(source, index, `${attributeName} ${message}.`);
}
