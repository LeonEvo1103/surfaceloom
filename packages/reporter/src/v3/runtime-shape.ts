import type { ReportBundleV3Input } from "./model.js";

type RecordValue = Record<string, unknown>;

export function validateRuntimeShapeV3(value: unknown): asserts value is ReportBundleV3Input {
  const input = record("report/v3 input", value);
  exact(input, ["run", "tests"], "report/v3 input");
  validateRun(requiredRecord(input, "run", "run"));
  requiredArray(input, "tests", "tests").forEach((item, index) =>
    validateTest(record(`tests[${index}]`, item), `tests[${index}]`));
}

/** Takes a getter-free data snapshot before semantic validation or sanitization. */
export function snapshotReportV3Input(value: unknown): ReportBundleV3Input {
  const snapshot = snapshotDataValue(value, "report/v3 input");
  validateRuntimeShapeV3(snapshot);
  return snapshot;
}

function validateRun(run: RecordValue): void {
  exact(run, ["id", "title", "startedAt", "finishedAt", "app", "environment",
    "provenance", "hosts", "surfaces"], "run");
  strings(run, ["id", "title", "startedAt", "finishedAt"], "run");
  const app = requiredRecord(run, "app", "run.app");
  exact(app, ["id", "name", "version", "build"], "run.app");
  strings(app, ["id", "name"], "run.app");
  optionalStrings(app, ["version", "build"], "run.app");
  if (has(run, "environment")) validateEnvironment(record("run.environment", run.environment));
  validateProvenance(requiredRecord(run, "provenance", "run.provenance"));
  validateCollection(requiredRecord(run, "hosts", "run.hosts"), "run.hosts", validateHost);
  validateCollection(requiredRecord(run, "surfaces", "run.surfaces"), "run.surfaces", validateSurface);
}

function validateEnvironment(value: RecordValue): void {
  const keys = ["osName", "osVersion", "runnerName", "runnerVersion", "commit", "branch"];
  exact(value, [...keys, "ci"], "run.environment");
  optionalStrings(value, keys, "run.environment");
  if (has(value, "ci") && typeof value.ci !== "boolean") {
    throw new Error("run.environment.ci must be a boolean.");
  }
}

function validateProvenance(value: RecordValue): void {
  requiredString(value, "kind", "run.provenance.kind");
  if (value.kind === "native") {
    exact(value, ["kind"], "run.provenance");
    return;
  }
  exact(value, ["kind", "sourceSchemaVersion", "sourcePlatform", "limitations"], "run.provenance");
  strings(value, ["sourceSchemaVersion", "sourcePlatform"], "run.provenance");
  stringArray(requiredArray(value, "limitations", "run.provenance.limitations"), "run.provenance.limitations");
}

function validateCollection(
  value: RecordValue,
  label: string,
  validateItem: (item: RecordValue, label: string) => void,
): void {
  requiredString(value, "state", `${label}.state`);
  if (value.state === "unknown") {
    validateUnknown(value, label, []);
    return;
  }
  exact(value, ["state", "value"], label);
  requiredArray(value, "value", `${label}.value`).forEach((item, index) =>
    validateItem(record(`${label}.value[${index}]`, item), `${label}.value[${index}]`));
}

function validateHost(value: RecordValue, label: string): void {
  exact(value, ["id", "os", "name", "osVersion", "architecture"], label);
  strings(value, ["id", "os"], label);
  optionalStrings(value, ["name", "osVersion", "architecture"], label);
}

function validateSurface(value: RecordValue, label: string): void {
  exact(value, ["id", "kind", "hostId", "name", "capabilities"], label);
  strings(value, ["id", "kind"], label);
  optionalStrings(value, ["name"], label);
  validateScalarContext(requiredRecord(value, "hostId", `${label}.hostId`), `${label}.hostId`);
  if (has(value, "capabilities")) {
    stringArray(array(`${label}.capabilities`, value.capabilities), `${label}.capabilities`);
  }
}

function validateTest(value: RecordValue, label: string): void {
  exact(value, ["spec", "attempts"], label);
  record(`${label}.spec`, required(value, "spec", `${label}.spec`));
  const attempts = requiredRecord(value, "attempts", `${label}.attempts`);
  requiredString(attempts, "state", `${label}.attempts.state`);
  if (attempts.state === "unknown") {
    validateUnknown(attempts, `${label}.attempts`, ["result"]);
    record(`${label}.attempts.result`, required(attempts, "result", `${label}.attempts.result`));
    return;
  }
  exact(attempts, ["state", "finalAttemptId", "items"], `${label}.attempts`);
  requiredString(attempts, "finalAttemptId", `${label}.attempts.finalAttemptId`);
  requiredArray(attempts, "items", `${label}.attempts.items`).forEach((item, index) =>
    validateAttempt(record(`${label}.attempts.items[${index}]`, item), `${label}.attempts.items[${index}]`));
}

function validateAttempt(value: RecordValue, label: string): void {
  exact(value, ["id", "ordinal", "executionPlatforms", "runnerHostId", "surfaceIds", "result"], label);
  requiredString(value, "id", `${label}.id`);
  if (typeof required(value, "ordinal", `${label}.ordinal`) !== "number") {
    throw new Error(`${label}.ordinal must be a number.`);
  }
  stringArray(requiredArray(value, "executionPlatforms", `${label}.executionPlatforms`),
    `${label}.executionPlatforms`);
  validateScalarContext(
    requiredRecord(value, "runnerHostId", `${label}.runnerHostId`),
    `${label}.runnerHostId`,
  );
  const surfaces = requiredRecord(value, "surfaceIds", `${label}.surfaceIds`);
  requiredString(surfaces, "state", `${label}.surfaceIds.state`);
  if (surfaces.state === "unknown") validateUnknown(surfaces, `${label}.surfaceIds`, []);
  else {
    exact(surfaces, ["state", "value"], `${label}.surfaceIds`);
    stringArray(requiredArray(surfaces, "value", `${label}.surfaceIds.value`), `${label}.surfaceIds.value`);
  }
  record(`${label}.result`, required(value, "result", `${label}.result`));
}

function validateScalarContext(value: RecordValue, label: string): void {
  requiredString(value, "state", `${label}.state`);
  if (value.state === "unknown") validateUnknown(value, label, []);
  else {
    exact(value, ["state", "value"], label);
    requiredString(value, "value", `${label}.value`);
  }
}

function validateUnknown(value: RecordValue, label: string, extra: readonly string[]): void {
  exact(value, ["state", "reason", "detail", ...extra], label);
  requiredString(value, "reason", `${label}.reason`);
  optionalStrings(value, ["detail"], label);
}

function record(label: string, value: unknown): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label}.${key} must be an enumerable data field.`);
    }
  }
  return value as RecordValue;
}

function exact(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`${label} contains an unknown field.`);
  }
}

function has(value: RecordValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function required(value: RecordValue, key: string, label: string): unknown {
  if (!has(value, key)) throw new Error(`${label} is required.`);
  return value[key];
}

function requiredRecord(value: RecordValue, key: string, label: string): RecordValue {
  return record(label, required(value, key, label));
}

function requiredArray(value: RecordValue, key: string, label: string): unknown[] {
  return array(label, required(value, key, label));
}

function array(label: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (Reflect.ownKeys(value).some((key) => key !== "length"
      && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)))) {
    throw new Error(`${label} must not contain custom properties.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label}[${index}] must be an enumerable data item.`);
    }
  }
  return value;
}

function requiredString(value: RecordValue, key: string, label: string): void {
  if (typeof required(value, key, label) !== "string") throw new Error(`${label} must be a string.`);
}

function strings(value: RecordValue, keys: readonly string[], label: string): void {
  keys.forEach((key) => requiredString(value, key, `${label}.${key}`));
}

function optionalStrings(value: RecordValue, keys: readonly string[], label: string): void {
  keys.forEach((key) => {
    if (has(value, key) && typeof value[key] !== "string") {
      throw new Error(`${label}.${key} must be a string.`);
    }
  });
}

function stringArray(values: readonly unknown[], label: string): void {
  values.forEach((value, index) => {
    if (!Object.prototype.hasOwnProperty.call(values, index) || typeof value !== "string") {
      throw new Error(`${label} must contain only strings.`);
    }
  });
}

export function snapshotDataValue(value: unknown, label: string, depth = 0): unknown {
  if (depth > 64) throw new Error(`${label} exceeds the snapshot nesting limit.`);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const checked = array(label, value);
    return checked.map((item, index) => snapshotDataValue(item, `${label}[${index}]`, depth + 1));
  }
  const checked = record(label, value);
  return Object.fromEntries(Object.entries(checked).map(([key, item]) => [
    key, snapshotDataValue(item, `${label}.${key}`, depth + 1),
  ]));
}
