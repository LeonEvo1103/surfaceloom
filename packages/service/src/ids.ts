import { randomUUID } from "node:crypto";

declare const identityBrand: unique symbol;

type BrandedIdentity<Kind extends string> = string & {
  readonly [identityBrand]: Kind;
};

export type TestId = BrandedIdentity<"service-test">;
export type OperationId = BrandedIdentity<"workspace-operation">;
export type RunId = BrandedIdentity<"service-run">;
export type TaskId = BrandedIdentity<"planner-task">;

const serviceTestIdPattern =
  /^service-test:[a-z0-9](?:[a-z0-9._-]{0,62})\/[a-z0-9](?:[a-z0-9._-]{0,126})$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function parseTestId(value: unknown): TestId {
  if (typeof value !== "string" || !serviceTestIdPattern.test(value)) {
    throw new TypeError(
      "A service testId must use service-test:<namespace>/<name> with lowercase stable segments.",
    );
  }
  return value as TestId;
}

export function parseOperationId(value: unknown): OperationId {
  return parseUuidIdentity("operation", value) as OperationId;
}

export function parseRunId(value: unknown): RunId {
  return parseUuidIdentity("run", value) as RunId;
}

export function parseTaskId(value: unknown): TaskId {
  return parseUuidIdentity("task", value) as TaskId;
}

export function createOperationId(): OperationId {
  return `operation:${randomUUID()}` as OperationId;
}

export function createRunId(): RunId {
  return `run:${randomUUID()}` as RunId;
}

export function createTaskId(): TaskId {
  return `task:${randomUUID()}` as TaskId;
}

function parseUuidIdentity(
  kind: "operation" | "run" | "task",
  value: unknown,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`A ${kind}Id must be a string.`);
  }
  const prefix = `${kind}:`;
  const uuid = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  if (!uuidPattern.test(uuid)) {
    throw new TypeError(`A ${kind}Id must use ${prefix}<uuid>.`);
  }
  return value;
}
