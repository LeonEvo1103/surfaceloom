import type { ReportBundleInput } from "./model.js";

type RuntimeRecord = Record<string, unknown>;

export function validateRuntimeShape(value: unknown): asserts value is ReportBundleInput {
  const input = record("report input", value);
  exactKeys("report input", input, ["run", "tests"]);
  const run = requiredRecord(input, "run", "run");
  exactKeys("run", run, [
    "id", "title", "platform", "startedAt", "finishedAt", "app", "environment",
  ]);
  for (const key of ["id", "title", "platform", "startedAt", "finishedAt"]) {
    requiredString(run, key, `run.${key}`);
  }

  const app = requiredRecord(run, "app", "run.app");
  exactKeys("run.app", app, ["id", "name", "version", "build"]);
  requiredString(app, "id", "run.app.id");
  requiredString(app, "name", "run.app.name");
  optionalString(app, "version", "run.app.version");
  optionalString(app, "build", "run.app.build");

  if (has(run, "environment")) validateEnvironment(run.environment);
  const tests = requiredArray(input, "tests", "tests");
  for (const [index, test] of tests.entries()) validateTest(test, index);
}

function validateEnvironment(value: unknown): void {
  const environment = record("run.environment", value);
  const stringKeys = [
    "osName", "osVersion", "runnerName", "runnerVersion", "commit", "branch",
  ];
  exactKeys("run.environment", environment, [...stringKeys, "ci"]);
  for (const key of stringKeys) optionalString(environment, key, `run.environment.${key}`);
  optionalBoolean(environment, "ci", "run.environment.ci");
}

function validateTest(value: unknown, index: number): void {
  const label = `tests[${index}]`;
  const test = record(label, value);
  exactKeys(label, test, ["spec", "result"]);
  validateCaseSpec(requiredRecord(test, "spec", `${label}.spec`), `${label}.spec`);
  const result = requiredRecord(test, "result", `${label}.result`);
  exactKeys(`${label}.result`, result, [
    "status", "startedAt", "durationMs", "steps", "artifacts", "error", "reason",
  ]);
  for (const key of ["status", "startedAt"]) {
    requiredString(result, key, `${label}.result.${key}`);
  }
  requiredNumber(result, "durationMs", `${label}.result.durationMs`);
  const steps = requiredArray(result, "steps", `${label}.result.steps`);
  for (const [stepIndex, step] of steps.entries()) {
    validateStep(step, `${label}.result.steps[${stepIndex}]`);
  }
  if (has(result, "artifacts")) {
    const artifacts = array(`${label}.result.artifacts`, result.artifacts);
    for (const [artifactIndex, artifact] of artifacts.entries()) {
      validateArtifact(artifact, `${label}.result.artifacts[${artifactIndex}]`);
    }
  }
  if (has(result, "error")) validateError(result.error, `${label}.result.error`);
  optionalString(result, "reason", `${label}.result.reason`);
}

function validateCaseSpec(spec: RuntimeRecord, label: string): void {
  exactKeys(label, spec, [
    "id", "locale", "platforms", "suite", "name", "sourceName", "intent", "preconditions",
    "acceptanceCriteria", "sideEffect", "tags",
  ]);
  for (const key of ["id", "locale", "name", "intent", "sideEffect"]) {
    requiredString(spec, key, `${label}.${key}`);
  }
  optionalString(spec, "sourceName", `${label}.sourceName`);
  if (has(spec, "platforms")) {
    stringArray(array(`${label}.platforms`, spec.platforms), `${label}.platforms`);
  }
  const suite = requiredRecord(spec, "suite", `${label}.suite`);
  exactKeys(`${label}.suite`, suite, ["id", "name"]);
  requiredString(suite, "id", `${label}.suite.id`);
  requiredString(suite, "name", `${label}.suite.name`);
  for (const key of ["preconditions", "acceptanceCriteria"]) {
    const clauses = requiredArray(spec, key, `${label}.${key}`);
    for (const [index, clause] of clauses.entries()) {
      validateClause(clause, `${label}.${key}[${index}]`);
    }
  }
  if (has(spec, "tags")) {
    stringArray(array(`${label}.tags`, spec.tags), `${label}.tags`);
  }
}

function validateClause(value: unknown, label: string): void {
  const clause = record(label, value);
  exactKeys(label, clause, ["id", "text"]);
  requiredString(clause, "id", `${label}.id`);
  requiredString(clause, "text", `${label}.text`);
}

function validateStep(value: unknown, label: string): void {
  const step = record(label, value);
  exactKeys(label, step, [
    "id", "title", "status", "durationMs", "componentId", "action", "assertion",
    "diagnostic", "criterionIds",
  ]);
  for (const key of ["id", "title", "status"]) requiredString(step, key, `${label}.${key}`);
  requiredNumber(step, "durationMs", `${label}.durationMs`);
  for (const key of ["componentId", "action", "assertion", "diagnostic"]) {
    optionalString(step, key, `${label}.${key}`);
  }
  if (has(step, "criterionIds")) {
    stringArray(array(`${label}.criterionIds`, step.criterionIds), `${label}.criterionIds`);
  }
}

function validateArtifact(value: unknown, label: string): void {
  const artifact = record(label, value);
  exactKeys(label, artifact, [
    "id", "kind", "phase", "title", "captureStatus", "sourcePath", "contentType",
    "capturedAt", "reviewPriority", "stepId", "description", "sensitive", "durationMs",
    "relatedArtifactIds", "captureError",
  ]);
  for (const key of ["id", "kind", "phase", "title", "captureStatus", "contentType", "capturedAt"]) {
    requiredString(artifact, key, `${label}.${key}`);
  }
  for (const key of ["sourcePath", "reviewPriority", "stepId", "description", "captureError"]) {
    optionalString(artifact, key, `${label}.${key}`);
  }
  optionalBoolean(artifact, "sensitive", `${label}.sensitive`);
  optionalNumber(artifact, "durationMs", `${label}.durationMs`);
  if (has(artifact, "relatedArtifactIds")) {
    stringArray(array(`${label}.relatedArtifactIds`, artifact.relatedArtifactIds), `${label}.relatedArtifactIds`);
  }
}

function validateError(value: unknown, label: string): void {
  const error = record(label, value);
  exactKeys(label, error, ["category", "message", "expected", "actual"]);
  requiredString(error, "category", `${label}.category`);
  requiredString(error, "message", `${label}.message`);
  if (has(error, "expected")) traceValue(`${label}.expected`, error.expected, new WeakSet(), 0);
  if (has(error, "actual")) traceValue(`${label}.actual`, error.actual, new WeakSet(), 0);
}

function traceValue(label: string, value: unknown, seen: WeakSet<object>, depth: number): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || depth >= 32) throw new Error(`${label} must be JSON-safe trace data.`);
  if (seen.has(value)) throw new Error(`${label} must not contain cycles.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => traceValue(`${label}[${index}]`, item, seen, depth + 1));
  } else {
    const object = record(label, value);
    for (const [index, item] of Object.values(object).entries()) {
      traceValue(`${label}.field[${index}]`, item, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function record(label: string, value: unknown): RuntimeRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as RuntimeRecord;
}

function exactKeys(label: string, value: RuntimeRecord, allowed: readonly string[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains an unknown field.`);
}

function has(value: RuntimeRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function required(value: RuntimeRecord, key: string, label: string): unknown {
  if (!has(value, key)) throw new Error(`${label} is required.`);
  return value[key];
}

function requiredRecord(value: RuntimeRecord, key: string, label: string): RuntimeRecord {
  return record(label, required(value, key, label));
}

function requiredArray(value: RuntimeRecord, key: string, label: string): unknown[] {
  return array(label, required(value, key, label));
}

function array(label: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredString(value: RuntimeRecord, key: string, label: string): void {
  if (typeof required(value, key, label) !== "string") throw new Error(`${label} must be a string.`);
}

function optionalString(value: RuntimeRecord, key: string, label: string): void {
  if (has(value, key) && typeof value[key] !== "string") throw new Error(`${label} must be a string.`);
}

function requiredNumber(value: RuntimeRecord, key: string, label: string): void {
  if (typeof required(value, key, label) !== "number") throw new Error(`${label} must be a number.`);
}

function optionalNumber(value: RuntimeRecord, key: string, label: string): void {
  if (has(value, key) && typeof value[key] !== "number") throw new Error(`${label} must be a number.`);
}

function optionalBoolean(value: RuntimeRecord, key: string, label: string): void {
  if (has(value, key) && typeof value[key] !== "boolean") throw new Error(`${label} must be a boolean.`);
}

function stringArray(values: readonly unknown[], label: string): void {
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(values, index)
        || typeof values[index] !== "string") {
      throw new Error(`${label} must contain only strings.`);
    }
  }
}
