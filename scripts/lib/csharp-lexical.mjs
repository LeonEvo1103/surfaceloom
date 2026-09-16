/** Returns the exclusive end of a C# comment or literal beginning at `start`. */
export function skipCSharpOpaque(source, start) {
  if (source.startsWith("//", start)) return skipCSharpLineComment(source, start + 2);
  if (source.startsWith("/*", start)) return skipCSharpBlockComment(source, start);
  return skipUnrelatedCSharpLiteral(source, start);
}

/** Skips any C# string/character form that is unrelated to a parsed attribute. */
export function skipUnrelatedCSharpLiteral(source, start) {
  if (source[start] === "'") return skipQuoted(source, start, "'", false);

  if (source[start] === "$") {
    let cursor = start;
    while (source[cursor] === "$") cursor += 1;
    if (countQuotes(source, cursor) >= 3) return skipRawString(source, cursor);
    if (cursor === start + 1 && source.startsWith('@"', cursor)) {
      return skipInterpolatedQuoted(source, cursor + 1, true);
    }
    if (cursor === start + 1 && source[cursor] === '"') {
      return skipInterpolatedQuoted(source, cursor, false);
    }
  }
  if (source.startsWith('@$"', start)) {
    return skipInterpolatedQuoted(source, start + 2, true);
  }
  if (source.startsWith('@"', start)) return skipQuoted(source, start + 1, '"', true);
  if (countQuotes(source, start) >= 3) return skipRawString(source, start);
  if (source[start] === '"') return skipQuoted(source, start, '"', false);
  return undefined;
}

/** Skips whitespace and comments, throwing for an unterminated block comment. */
export function skipCSharpTrivia(source, start) {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/u.test(source[cursor])) cursor += 1;
    else if (source.startsWith("//", cursor)) cursor = skipLineComment(source, cursor + 2);
    else if (source.startsWith("/*", cursor)) cursor = skipBlockComment(source, cursor);
    else break;
  }
  return cursor;
}

export function skipCSharpLineComment(source, start) {
  const newline = source.indexOf("\n", start);
  return newline === -1 ? source.length : newline + 1;
}

export function skipCSharpBlockComment(source, start) {
  const closing = source.indexOf("*/", start + 2);
  if (closing === -1) throw csharpSourceError(source, start, "C# source contains an unterminated block comment.");
  return closing + 2;
}

export function csharpLineAndColumn(source, index) {
  let line = 1;
  let column = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === "\n") {
      line += 1;
      column = 1;
    } else column += 1;
  }
  return { line, column };
}

export function csharpSourceError(source, index, message) {
  const location = csharpLineAndColumn(source, index);
  return new Error(`${message} (${location.line}:${location.column})`);
}

export function isCSharpIdentifierCharacter(character) {
  return character !== undefined
    && /^[_\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}]$/u.test(character);
}

function skipQuoted(source, quoteIndex, quote, verbatim) {
  let cursor = quoteIndex + 1;
  while (cursor < source.length) {
    if (source[cursor] === quote) {
      if (verbatim && source[cursor + 1] === quote) cursor += 2;
      else return cursor + 1;
    } else if (!verbatim && source[cursor] === "\\") cursor = Math.min(source.length, cursor + 2);
    else cursor += 1;
  }
  throw csharpSourceError(source, quoteIndex, "C# source contains an unterminated string or character literal.");
}

function skipInterpolatedQuoted(source, quoteIndex, verbatim) {
  let cursor = quoteIndex + 1;
  while (cursor < source.length) {
    if (source[cursor] === '"') {
      if (verbatim && source[cursor + 1] === '"') cursor += 2;
      else return cursor + 1;
    } else if (!verbatim && source[cursor] === "\\") {
      cursor = Math.min(source.length, cursor + 2);
    } else if (source[cursor] === "{" && source[cursor + 1] === "{") {
      cursor += 2;
    } else if (source[cursor] === "{") {
      cursor = skipInterpolation(source, cursor);
    } else if (source[cursor] === "}" && source[cursor + 1] === "}") {
      cursor += 2;
    } else cursor += 1;
  }
  throw csharpSourceError(source, quoteIndex, "C# source contains an unterminated interpolated string literal.");
}

function skipInterpolation(source, openingBrace) {
  let depth = 1;
  let cursor = openingBrace + 1;
  while (cursor < source.length) {
    const opaqueEnd = skipCSharpOpaque(source, cursor);
    if (opaqueEnd !== undefined) {
      cursor = opaqueEnd;
      continue;
    }
    if (source[cursor] === "{") depth += 1;
    else if (source[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    cursor += 1;
  }
  throw csharpSourceError(source, openingBrace, "C# interpolation is unterminated.");
}

function skipRawString(source, start) {
  const width = countQuotes(source, start);
  const closing = '"'.repeat(width);
  const end = source.indexOf(closing, start + width);
  if (end === -1) throw csharpSourceError(source, start, "C# source contains an unterminated raw string literal.");
  return end + width;
}

function countQuotes(source, start) {
  let width = 0;
  while (source[start + width] === '"') width += 1;
  return width;
}
