/** Returns the exclusive end of a Swift comment, string, or regex literal. */
export function skipSwiftOpaque(source, start) {
  if (source.startsWith("//", start)) return skipLineComment(source, start + 2);
  if (source.startsWith("/*", start)) return skipBlockComment(source, start);
  const string = swiftStringPrefix(source, start);
  if (string !== undefined) return skipSwiftString(source, string);
  const regex = swiftRegexPrefix(source, start);
  if (regex !== undefined) return skipSwiftRegex(source, regex);
  return undefined;
}

export function swiftStringPrefix(source, start) {
  let quoteIndex = start;
  while (source[quoteIndex] === "#") quoteIndex += 1;
  if (source[quoteIndex] !== '"') return undefined;
  return { start, quoteIndex, hashCount: quoteIndex - start };
}

export function skipSwiftString(source, prefix) {
  const triple = source.startsWith('"""', prefix.quoteIndex);
  const width = triple ? 3 : 1;
  const closing = `${'"'.repeat(width)}${"#".repeat(prefix.hashCount)}`;
  let cursor = prefix.quoteIndex + width;
  while (cursor < source.length) {
    if (source.startsWith(closing, cursor)) return cursor + closing.length;
    if (!triple && (source[cursor] === "\n" || source[cursor] === "\r")) {
      throw swiftSourceError(source, prefix.start, "Swift source contains an unterminated string literal.");
    }
    const escape = activeSwiftEscape(source, cursor, prefix.hashCount);
    if (escape?.character === "(") {
      cursor = skipInterpolation(source, escape.characterIndex);
    } else if (escape !== undefined) {
      cursor = Math.min(source.length, escape.characterIndex + 1);
    } else {
      cursor += 1;
    }
  }
  throw swiftSourceError(source, prefix.start, "Swift source contains an unterminated string literal.");
}

export function activeSwiftEscape(source, index, hashCount) {
  if (source[index] !== "\\") return undefined;
  for (let offset = 0; offset < hashCount; offset += 1) {
    if (source[index + 1 + offset] !== "#") return undefined;
  }
  const characterIndex = index + 1 + hashCount;
  return { character: source[characterIndex], characterIndex };
}

export function skipSwiftTrivia(source, start) {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/u.test(source[cursor])) cursor += 1;
    else if (source.startsWith("//", cursor)) cursor = skipLineComment(source, cursor + 2);
    else if (source.startsWith("/*", cursor)) cursor = skipBlockComment(source, cursor);
    else break;
  }
  return cursor;
}

export function skipLineComment(source, start) {
  const newline = source.indexOf("\n", start);
  return newline === -1 ? source.length : newline + 1;
}

export function skipBlockComment(source, start) {
  let depth = 1;
  let cursor = start + 2;
  while (cursor < source.length && depth > 0) {
    if (source.startsWith("/*", cursor)) {
      depth += 1;
      cursor += 2;
    } else if (source.startsWith("*/", cursor)) {
      depth -= 1;
      cursor += 2;
    } else cursor += 1;
  }
  if (depth !== 0) {
    throw swiftSourceError(source, start, "Swift source contains an unterminated block comment.");
  }
  return cursor;
}

export function swiftLineAndColumn(source, index) {
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

export function swiftSourceError(source, index, message) {
  const location = swiftLineAndColumn(source, index);
  return new Error(`${message} (${location.line}:${location.column})`);
}

function swiftRegexPrefix(source, start) {
  let slashIndex = start;
  while (source[slashIndex] === "#") slashIndex += 1;
  if (source[slashIndex] !== "/" || source[slashIndex + 1] === "/"
      || source[slashIndex + 1] === "*") return undefined;
  const hashCount = slashIndex - start;
  if (hashCount === 0 && !canStartBareRegex(source, start)) return undefined;
  return { start, slashIndex, hashCount };
}

function skipSwiftRegex(source, prefix) {
  const closing = `/${"#".repeat(prefix.hashCount)}`;
  let cursor = prefix.slashIndex + 1;
  let inCharacterClass = false;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\n" || character === "\r") {
      throw swiftSourceError(source, prefix.start, "Swift source contains an unterminated regex literal.");
    }
    const escape = activeSwiftEscape(source, cursor, prefix.hashCount);
    if (escape?.character === "(") {
      cursor = skipInterpolation(source, escape.characterIndex);
      continue;
    }
    if (escape !== undefined) {
      cursor = Math.min(source.length, escape.characterIndex + 1);
      continue;
    }
    if (character === "[") inCharacterClass = true;
    else if (character === "]") inCharacterClass = false;
    else if (!inCharacterClass && source.startsWith(closing, cursor)) {
      return cursor + closing.length;
    }
    cursor += 1;
  }
  throw swiftSourceError(source, prefix.start, "Swift source contains an unterminated regex literal.");
}

function skipInterpolation(source, openingParenthesis) {
  let depth = 1;
  let cursor = openingParenthesis + 1;
  while (cursor < source.length) {
    const opaqueEnd = skipSwiftOpaque(source, cursor);
    if (opaqueEnd !== undefined) {
      cursor = opaqueEnd;
      continue;
    }
    if (source[cursor] === "(") depth += 1;
    else if (source[cursor] === ")") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    cursor += 1;
  }
  throw swiftSourceError(source, openingParenthesis, "Swift interpolation is unterminated.");
}

function canStartBareRegex(source, start) {
  let cursor = start - 1;
  while (cursor >= 0 && /\s/u.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  if ("=([{,:;!?&|+-*%^~<>".includes(source[cursor])) return true;
  const prefix = source.slice(0, cursor + 1);
  return /\b(?:return|throw|case|in|where|try|await)\s*$/u.test(prefix);
}
