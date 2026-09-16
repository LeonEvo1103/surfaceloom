import { evaluateStaticBooleanExpression } from "./static-boolean-expression.mjs";

/**
 * Replaces inactive conditional-compilation branches and directive lines with
 * spaces while preserving UTF-16 offsets and newlines.
 * `skipOpaque` must return the exclusive end of a comment or literal beginning
 * at `start`, or undefined. It is called only in active source so excluded code
 * may contain arbitrary, otherwise-invalid tokens just as a compiler permits.
 */
export function maskConditionalCompilation(
  source,
  { language, elseifKeyword, skipOpaque },
) {
  if (typeof source !== "string") throw new TypeError(`${language} source must be a string.`);
  if (typeof skipOpaque !== "function") throw new TypeError("skipOpaque must be a function.");
  const masked = source.split("");
  const stack = [];
  let active = true;
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === "#" && isFirstTokenOnLine(source, cursor)) {
      const directive = readDirective(source, cursor);
      if (directive !== undefined) {
        if ((directive.keyword === "elseif" || directive.keyword === "elif")
            && directive.keyword !== elseifKeyword) {
          throw compilationError(
            source,
            cursor,
            language,
            `uses unsupported #${directive.keyword}; expected #${elseifKeyword}`,
          );
        }
        active = applyDirective(source, directive, stack, active, language);
        maskRange(masked, cursor, directive.end);
        cursor = directive.end;
        continue;
      }
    }
    if (active) {
      const opaqueEnd = skipOpaque(source, cursor);
      if (opaqueEnd !== undefined) {
        cursor = opaqueEnd;
        continue;
      }
    } else if (source[cursor] !== "\n" && source[cursor] !== "\r") {
      masked[cursor] = " ";
    }
    cursor += 1;
  }
  if (stack.length > 0) {
    throw compilationError(source, stack.at(-1).start, language, "unterminated #if block");
  }
  return masked.join("");
}

function readDirective(source, start) {
  const end = lineEnd(source, start);
  const line = source.slice(start, end);
  const match = /^#\s*(if|else|endif|elseif|elif)\b([^\r\n]*)$/u.exec(line);
  if (match === null) return undefined;
  const keyword = match[1];
  return { start, end, keyword, expression: stripLineComment(match[2]).trim() };
}

function applyDirective(source, directive, stack, currentActive, language) {
  const { keyword, expression, start } = directive;
  if (keyword === "if") {
    const condition = currentActive
      ? requireKnownCondition(source, start, expression, language)
      : false;
    const frame = {
      start,
      parentActive: currentActive,
      branchTaken: currentActive && condition,
      active: currentActive && condition,
      sawElse: false,
    };
    stack.push(frame);
    return frame.active;
  }

  const frame = stack.at(-1);
  if (frame === undefined) {
    throw compilationError(source, start, language, `unexpected #${keyword}`);
  }
  if (keyword === "endif") {
    requireEmptyExpression(source, directive, language);
    stack.pop();
    return frame.parentActive;
  }
  if (frame.sawElse) {
    throw compilationError(source, start, language, `#${keyword} follows #else`);
  }
  if (keyword === "else") {
    requireEmptyExpression(source, directive, language);
    frame.sawElse = true;
    frame.active = frame.parentActive && !frame.branchTaken;
    frame.branchTaken ||= frame.active;
    return frame.active;
  }
  if (!frame.parentActive || frame.branchTaken) {
    frame.active = false;
  } else {
    frame.active = requireKnownCondition(source, start, expression, language);
    frame.branchTaken ||= frame.active;
  }
  return frame.active;
}

function requireKnownCondition(source, start, expression, language) {
  if (expression.length === 0) {
    throw compilationError(source, start, language, "#if condition is empty");
  }
  let value;
  try {
    value = evaluateStaticBooleanExpression(expression);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw compilationError(source, start, language, `cannot parse conditional expression: ${detail}`);
  }
  if (value === undefined) {
    throw compilationError(
      source,
      start,
      language,
      `cannot statically evaluate conditional expression ${JSON.stringify(expression)}`,
    );
  }
  return value;
}

function requireEmptyExpression(source, directive, language) {
  if (directive.expression.length > 0) {
    throw compilationError(source, directive.start, language, `#${directive.keyword} has trailing tokens`);
  }
}

function isFirstTokenOnLine(source, index) {
  for (let cursor = index - 1; cursor >= 0 && source[cursor] !== "\n"; cursor -= 1) {
    if (source[cursor] !== " " && source[cursor] !== "\t" && source[cursor] !== "\r") return false;
  }
  return true;
}

function lineEnd(source, start) {
  const newline = source.indexOf("\n", start);
  return newline === -1 ? source.length : newline;
}

function stripLineComment(value) {
  const comment = value.indexOf("//");
  return comment === -1 ? value : value.slice(0, comment);
}

function maskRange(masked, start, end) {
  for (let index = start; index < end; index += 1) {
    if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
  }
}

function compilationError(source, index, language, message) {
  const before = source.slice(0, index);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = index - lastNewline;
  return new Error(`${language} conditional compilation ${message} (${line}:${column})`);
}
