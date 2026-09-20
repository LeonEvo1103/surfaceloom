export function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  const unexpected = keys.find((key) => !allowed.has(key));
  if (unexpected !== undefined) throw new TypeError(`${label} has unknown field ${unexpected}.`);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new TypeError(`${label} is missing ${missing}.`);
}

export function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (value.length > 500) throw new TypeError(`${label} must not exceed 500 characters.`);
  return value;
}

export function machineId(value: unknown, label: string): string {
  const result = text(value, label);
  if (result.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(result)) {
    throw new TypeError(`${label} must use the stable machine-id character set.`);
  }
  return result;
}

export function stringList(value: unknown, label: string): readonly string[] {
  const values = array(value, label).map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError(`${label} must be unique.`);
  return values;
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TypeError(`${label} has an unsupported value.`);
  }
  return value as T;
}
