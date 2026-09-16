import { csharpSourceError } from "./csharp-lexical.mjs";

const identifierStart = /^[_\p{L}\p{Nl}]$/u;
const identifierPart = /^[_\p{L}\p{Nl}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}]$/u;
const formattingCharacter = /^\p{Cf}$/u;

/** Parses and decodes one C# identifier, including Unicode escape sequences. */
export function parseCSharpIdentifier(source, start) {
  let cursor = start;
  let verbatim = false;
  if (source[cursor] === "@") {
    verbatim = true;
    cursor += 1;
  }

  const first = readScalar(source, cursor);
  if (first === undefined) return undefined;
  if (!identifierStart.test(first.character)) {
    if (first.escaped) throw invalidIdentifierCharacter(source, cursor, "start");
    return undefined;
  }

  let name = formattingCharacter.test(first.character) ? "" : first.character;
  cursor = first.end;
  while (cursor < source.length) {
    const part = readScalar(source, cursor);
    if (part === undefined) break;
    if (!identifierPart.test(part.character)) {
      if (part.escaped) throw invalidIdentifierCharacter(source, cursor, "continuation");
      break;
    }
    if (!formattingCharacter.test(part.character)) name += part.character;
    cursor = part.end;
  }
  return { name, end: cursor, verbatim };
}

function readScalar(source, start) {
  if (source[start] === "\\") return decodeUnicodeEscape(source, start);
  const codePoint = source.codePointAt(start);
  if (codePoint === undefined) return undefined;
  const character = String.fromCodePoint(codePoint);
  return { character, end: start + character.length, escaped: false };
}

function decodeUnicodeEscape(source, start) {
  const marker = source[start + 1];
  if (marker !== "u" && marker !== "U") {
    throw csharpSourceError(
      source,
      start,
      "C# identifier contains an unsupported escape; expected \\uXXXX or \\UXXXXXXXX.",
    );
  }
  const width = marker === "u" ? 4 : 8;
  const digitsStart = start + 2;
  const digits = source.slice(digitsStart, digitsStart + width);
  if (digits.length !== width || !/^[0-9A-Fa-f]+$/u.test(digits)) {
    throw csharpSourceError(source, start, "C# identifier contains an invalid Unicode escape.");
  }
  const codePoint = Number.parseInt(digits, 16);
  if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    throw csharpSourceError(source, start, "C# identifier escape contains an invalid Unicode scalar.");
  }
  return {
    character: String.fromCodePoint(codePoint),
    end: digitsStart + width,
    escaped: true,
  };
}

function invalidIdentifierCharacter(source, start, position) {
  return csharpSourceError(
    source,
    start,
    `C# identifier escape does not decode to a valid identifier ${position} character.`,
  );
}
