/** Evaluates a constant boolean expression, returning undefined for unknown identifiers. */
export function evaluateStaticBooleanExpression(expression) {
  const tokens = tokenize(expression);
  let position = 0;
  const parsePrimary = () => {
    const token = tokens[position++];
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "(") {
      const value = parseOr();
      if (tokens[position++] !== ")") throw new Error("missing closing parenthesis");
      return value;
    }
    if (token?.type === "identifier") return undefined;
    throw new Error(`unexpected token ${JSON.stringify(token ?? "<end>")}`);
  };
  const parseUnary = () => tokens[position] === "!"
    ? (position += 1, triNot(parseUnary()))
    : parsePrimary();
  const parseEquality = () => {
    let value = parseUnary();
    while (tokens[position] === "==" || tokens[position] === "!=") {
      const operator = tokens[position++];
      const right = parseUnary();
      value = value === undefined || right === undefined
        ? undefined
        : operator === "==" ? value === right : value !== right;
    }
    return value;
  };
  const parseAnd = () => {
    let value = parseEquality();
    while (tokens[position] === "&&") {
      position += 1;
      value = triAnd(value, parseEquality());
    }
    return value;
  };
  const parseOr = () => {
    let value = parseAnd();
    while (tokens[position] === "||") {
      position += 1;
      value = triOr(value, parseAnd());
    }
    return value;
  };
  const value = parseOr();
  if (position !== tokens.length) {
    throw new Error(`unexpected token ${JSON.stringify(tokens[position])}`);
  }
  return value;
}

function tokenize(expression) {
  const tokens = [];
  let cursor = 0;
  while (cursor < expression.length) {
    if (/\s/u.test(expression[cursor])) {
      cursor += 1;
      continue;
    }
    const operator = ["&&", "||", "==", "!="].find(item => expression.startsWith(item, cursor));
    if (operator !== undefined) {
      tokens.push(operator);
      cursor += operator.length;
      continue;
    }
    if (expression[cursor] === "!" || expression[cursor] === "(" || expression[cursor] === ")") {
      tokens.push(expression[cursor++]);
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(expression.slice(cursor));
    if (identifier !== null) {
      tokens.push(identifier[0] === "true" || identifier[0] === "false"
        ? identifier[0]
        : { type: "identifier", value: identifier[0] });
      cursor += identifier[0].length;
      continue;
    }
    throw new Error(`unsupported token at column ${cursor + 1}`);
  }
  return tokens;
}

function triNot(value) { return value === undefined ? undefined : !value; }
function triAnd(left, right) {
  if (left === false || right === false) return false;
  return left === undefined || right === undefined ? undefined : true;
}
function triOr(left, right) {
  if (left === true || right === true) return true;
  return left === undefined || right === undefined ? undefined : false;
}
