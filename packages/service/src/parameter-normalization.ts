import type { NormalizedParameters } from "./execution.js";
import { deepFreeze, readSafeRecordEnvelope } from "./safe-data.js";
import type { ParameterDefinition, ParameterValue, TestDefinition } from "./test-definition.js";

export function normalizeParameters(
  definition: Readonly<TestDefinition>,
  input: unknown = {},
): NormalizedParameters {
  const source = readSafeRecordEnvelope(input, "parameters");
  const schema = definition.parameters;
  const unknown = Object.keys(source).find(name => !Object.hasOwn(schema.properties, name));
  if (unknown !== undefined) throw new TypeError(`Unknown parameter ${unknown}.`);
  const result: Record<string, ParameterValue> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const supplied = Object.hasOwn(source, name);
    const value = supplied ? source[name] : property.default;
    if (value === undefined) {
      if (schema.required.includes(name)) throw new TypeError(`Missing required parameter ${name}.`);
      continue;
    }
    result[name] = parameterValue(name, property, value);
  }
  return deepFreeze(result);
}

function parameterValue(
  name: string,
  definition: ParameterDefinition,
  value: unknown,
): ParameterValue {
  const valid = definition.type === "string" ? typeof value === "string"
    : definition.type === "boolean" ? typeof value === "boolean"
      : typeof value === "number" && Number.isFinite(value)
        && (definition.type !== "integer" || Number.isInteger(value));
  if (!valid) throw new TypeError(`Parameter ${name} must be ${definition.type}.`);
  if (definition.enum !== undefined && !definition.enum.includes(value as ParameterValue)) {
    throw new TypeError(`Parameter ${name} must be one of its declared values.`);
  }
  return value as ParameterValue;
}
