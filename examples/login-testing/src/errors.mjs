export class FixtureError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "FixtureError";
    this.code = code;
    this.status = status;
  }
}

export function requireObject(value, label = "body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FixtureError("INVALID_INPUT", `${label} must be an object`);
  }
  return value;
}

export function requireOnlyKeys(value, allowed) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new FixtureError("INVALID_INPUT", `Unexpected field: ${unexpected[0]}`);
  }
}
