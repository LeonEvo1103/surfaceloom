import {
  csharpSourceError,
  skipCSharpOpaque,
  skipCSharpTrivia,
} from "./csharp-lexical.mjs";
import { parseCSharpIdentifier } from "./csharp-identifiers.mjs";

/** Parses a C# attribute type and returns it only when its terminal name matches. */
export function parseMatchingCSharpAttributeTypeName(
  source,
  start,
  configuredName,
) {
  let segment = parseCSharpIdentifier(source, start);
  if (segment === undefined) return undefined;
  let cursor = skipCSharpTrivia(source, segment.end);
  let terminal = segment.name;

  if (source.startsWith("::", cursor)) {
    segment = parseCSharpIdentifier(source, skipCSharpTrivia(source, cursor + 2));
    if (segment === undefined) return undefined;
    terminal = segment.name;
    cursor = skipCSharpTrivia(source, segment.end);
  }

  while (source[cursor] === ".") {
    segment = parseCSharpIdentifier(source, skipCSharpTrivia(source, cursor + 1));
    if (segment === undefined) return undefined;
    terminal = segment.name;
    cursor = skipCSharpTrivia(source, segment.end);
  }

  return acceptedTerminalNames(configuredName).has(terminal)
    ? { end: cursor }
    : undefined;
}

/** Fails closed when a using alias hides the configured case attribute type. */
export function rejectCSharpAttributeTypeAliases(source, configuredName) {
  let index = 0;
  while (index < source.length) {
    const opaqueEnd = skipCSharpOpaque(source, index);
    if (opaqueEnd !== undefined) {
      index = opaqueEnd;
      continue;
    }
    const token = parseCSharpIdentifier(source, index);
    if (token !== undefined && token.name === "using" && !token.verbatim) {
      let aliasStart = skipCSharpTrivia(source, token.end);
      const modifier = parseCSharpIdentifier(source, aliasStart);
      if (modifier !== undefined && modifier.name === "unsafe" && !modifier.verbatim) {
        aliasStart = skipCSharpTrivia(source, modifier.end);
      }
      const alias = parseCSharpIdentifier(source, aliasStart);
      if (alias !== undefined) {
        const equals = skipCSharpTrivia(source, alias.end);
        if (source[equals] === "=") {
          const targetStart = skipCSharpTrivia(source, equals + 1);
          const target = parseMatchingCSharpAttributeTypeName(
            source,
            targetStart,
            configuredName,
          );
          if (target !== undefined && source[skipCSharpTrivia(source, target.end)] === ";") {
            throw csharpSourceError(
              source,
              index,
              `${configuredName} must not be hidden behind a using alias.`,
            );
          }
        }
      }
    }
    index = token?.end ?? index + 1;
  }
}

/** Fails closed when the configured attribute occurs after another grouped attribute. */
export function rejectCSharpGroupedTargetAttribute(
  source,
  sectionStart,
  configuredName,
) {
  let cursor = skipCSharpTrivia(source, sectionStart + 1);
  const possibleTargetSpecifier = parseCSharpIdentifier(source, cursor);
  const targetSpecifierEnd = possibleTargetSpecifier === undefined
    ? cursor
    : skipCSharpTrivia(source, possibleTargetSpecifier.end);
  const hasTargetSpecifier = source[targetSpecifierEnd] === ":"
    && source[targetSpecifierEnd + 1] !== ":";
  if (hasTargetSpecifier) {
    cursor = skipCSharpTrivia(source, targetSpecifierEnd + 1);
    rejectMatchingAttributeAt(
      source,
      cursor,
      configuredName,
      "must not use an attribute target specifier",
    );
  }
  const depths = { parentheses: 0, brackets: 0, braces: 0 };
  while (cursor < source.length) {
    const opaqueEnd = skipCSharpOpaque(source, cursor);
    if (opaqueEnd !== undefined) {
      cursor = opaqueEnd;
      continue;
    }
    const character = source[cursor];
    if (character === "(") depths.parentheses += 1;
    else if (character === ")" && depths.parentheses > 0) depths.parentheses -= 1;
    else if (character === "[") depths.brackets += 1;
    else if (character === "]") {
      if (depths.parentheses === 0 && depths.brackets === 0 && depths.braces === 0) return;
      if (depths.brackets > 0) depths.brackets -= 1;
    } else if (character === "{") depths.braces += 1;
    else if (character === "}" && depths.braces > 0) depths.braces -= 1;
    else if (character === "," && Object.values(depths).every(depth => depth === 0)) {
      const candidateStart = skipCSharpTrivia(source, cursor + 1);
      rejectMatchingAttributeAt(
        source,
        candidateStart,
        configuredName,
        hasTargetSpecifier
          ? "must not use an attribute target specifier"
          : "must be declared as a standalone attribute",
      );
    }
    cursor += 1;
  }
}

function rejectMatchingAttributeAt(source, start, configuredName, message) {
  const candidate = parseMatchingCSharpAttributeTypeName(source, start, configuredName);
  const following = candidate === undefined
    ? undefined
    : source[skipCSharpTrivia(source, candidate.end)];
  if (following === "(" || following === "," || following === "]") {
    throw csharpSourceError(source, start, `${configuredName} ${message}.`);
  }
}

function acceptedTerminalNames(configuredName) {
  const normalized = configuredName.startsWith("@")
    ? configuredName.slice(1)
    : configuredName;
  if (normalized.endsWith("Attribute") && normalized.length > "Attribute".length) {
    return new Set([normalized, normalized.slice(0, -"Attribute".length)]);
  }
  return new Set([normalized, `${normalized}Attribute`]);
}
