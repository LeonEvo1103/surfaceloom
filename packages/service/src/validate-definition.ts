import { parseTestId } from "./ids.js";
import { cloneSafeData, deepFreeze, readSafeRecordEnvelope } from "./safe-data.js";
import {
  type ParameterType,
  type ParameterValue,
  type TestDefinition,
} from "./test-definition.js";
import { array, exactKeys, machineId, oneOf, record, stringList, text } from "./validation.js";

const parameterTypes = ["string", "number", "integer", "boolean"] as const;
const runtimeKinds = ["node", "cli", "surfaceloom-v3"] as const;
const platforms = ["darwin", "linux", "win32"] as const;
const validEffectLevels = [
  "readOnly", "reversible", "writesLocal", "externalEffect", "securitySensitive",
] as const;

export function validateTestDefinition(input: unknown): Readonly<TestDefinition> {
  const envelope = readSafeRecordEnvelope(input, "TestDefinition");
  exactKeys(envelope, "TestDefinition", [
    "schemaVersion", "testId", "title", "description", "caseSpecs", "coverage",
    "parameters", "runtime", "effect", "requirements", "output",
  ]);
  const value = record(cloneSafeData(envelope), "TestDefinition");
  if (value.schemaVersion !== 1) throw new TypeError("TestDefinition.schemaVersion must be 1.");
  parseTestId(value.testId);
  text(value.title, "TestDefinition.title");
  text(value.description, "TestDefinition.description");
  validateCaseSpecs(value.caseSpecs);
  validateCoverage(value.coverage);
  validateParameters(value.parameters);
  validateRuntime(value.runtime);
  oneOf(value.effect, validEffectLevels, "TestDefinition.effect");
  validateRequirements(value.requirements);
  validateOutput(value.output);
  return deepFreeze(value as unknown as TestDefinition);
}

function validateCaseSpecs(input: unknown): void {
  const seen = new Set<string>();
  for (const [index, item] of array(input, "TestDefinition.caseSpecs").entries()) {
    const value = record(item, `caseSpecs[${index}]`);
    exactKeys(value, `caseSpecs[${index}]`, ["id"], ["source"]);
    const id = machineId(value.id, `caseSpecs[${index}].id`);
    if (seen.has(id)) throw new TypeError(`Duplicate CaseSpec reference ${id}.`);
    seen.add(id);
    if (value.source !== undefined) text(value.source, `caseSpecs[${index}].source`);
  }
}

function validateCoverage(input: unknown): void {
  const value = record(input, "TestDefinition.coverage");
  exactKeys(value, "TestDefinition.coverage", ["includes", "exclusions"]);
  stringList(value.includes, "coverage.includes");
  const seen = new Set<string>();
  for (const [index, item] of array(value.exclusions, "coverage.exclusions").entries()) {
    const exclusion = record(item, `coverage.exclusions[${index}]`);
    exactKeys(exclusion, `coverage.exclusions[${index}]`, ["target", "reason"]);
    const target = text(exclusion.target, `coverage.exclusions[${index}].target`);
    text(exclusion.reason, `coverage.exclusions[${index}].reason`);
    if (seen.has(target)) throw new TypeError(`Duplicate coverage exclusion ${target}.`);
    seen.add(target);
  }
}

function validateParameters(input: unknown): void {
  const value = record(input, "TestDefinition.parameters");
  exactKeys(value, "TestDefinition.parameters", [
    "type", "properties", "required", "additionalProperties",
  ]);
  if (value.type !== "object") throw new TypeError("parameters.type must be object.");
  if (value.additionalProperties !== false) {
    throw new TypeError("parameters.additionalProperties must be false.");
  }
  const properties = record(value.properties, "parameters.properties");
  for (const [name, item] of Object.entries(properties)) validateParameter(name, item);
  const required = stringList(value.required, "parameters.required");
  for (const name of required) {
    if (!Object.hasOwn(properties, name)) throw new TypeError(`Unknown required parameter ${name}.`);
  }
}

function validateParameter(name: string, input: unknown): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name)) {
    throw new TypeError(`Invalid parameter name ${name}.`);
  }
  const value = record(input, `parameter ${name}`);
  exactKeys(value, `parameter ${name}`, ["type", "description"], ["default", "enum"]);
  const type = oneOf(value.type, parameterTypes, `parameter ${name}.type`);
  text(value.description, `parameter ${name}.description`);
  const choices = value.enum === undefined
    ? undefined
    : array(value.enum, `parameter ${name}.enum`).map((item) => parameterValue(item, type, name));
  if (choices !== undefined && new Set(choices).size !== choices.length) {
    throw new TypeError(`parameter ${name}.enum must be unique.`);
  }
  if (value.default !== undefined) {
    const defaultValue = parameterValue(value.default, type, name);
    if (choices !== undefined && !choices.includes(defaultValue)) {
      throw new TypeError(`parameter ${name}.default must occur in its enum.`);
    }
  }
}

function parameterValue(value: unknown, type: ParameterType, name: string): ParameterValue {
  const valid = type === "string" ? typeof value === "string"
    : type === "boolean" ? typeof value === "boolean"
      : typeof value === "number" && Number.isFinite(value)
        && (type !== "integer" || Number.isInteger(value));
  if (!valid) throw new TypeError(`parameter ${name} has a value inconsistent with ${type}.`);
  return value as ParameterValue;
}

function validateRuntime(input: unknown): void {
  const value = record(input, "TestDefinition.runtime");
  exactKeys(value, "TestDefinition.runtime", ["executorId", "kind"]);
  machineId(value.executorId, "runtime.executorId");
  oneOf(value.kind, runtimeKinds, "runtime.kind");
}

function validateRequirements(input: unknown): void {
  const value = record(input, "TestDefinition.requirements");
  exactKeys(value, "TestDefinition.requirements", ["platforms", "capabilities", "environment"]);
  const platformValues = array(value.platforms, "requirements.platforms")
    .map((item) => oneOf(item, platforms, "requirements.platform"));
  if (new Set(platformValues).size !== platformValues.length) {
    throw new TypeError("requirements.platforms must be unique.");
  }
  stringList(value.capabilities, "requirements.capabilities");
  const environment = stringList(value.environment, "requirements.environment");
  for (const name of environment) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) throw new TypeError(`Invalid environment name ${name}.`);
  }
}

function validateOutput(input: unknown): void {
  const value = record(input, "TestDefinition.output");
  exactKeys(value, "TestDefinition.output", ["resultFormat", "artifacts"]);
  if (value.resultFormat !== "surfaceloom.run-result/v1") {
    throw new TypeError("output.resultFormat must be surfaceloom.run-result/v1.");
  }
  const seen = new Set<string>();
  for (const [index, item] of array(value.artifacts, "output.artifacts").entries()) {
    const artifact = record(item, `output.artifacts[${index}]`);
    exactKeys(artifact, `output.artifacts[${index}]`, ["name", "mediaType", "required"]);
    const name = machineId(artifact.name, `output.artifacts[${index}].name`);
    text(artifact.mediaType, `output.artifacts[${index}].mediaType`);
    if (typeof artifact.required !== "boolean") throw new TypeError("artifact.required must be boolean.");
    if (seen.has(name)) throw new TypeError(`Duplicate output artifact ${name}.`);
    seen.add(name);
  }
}
