import path from "node:path";

import type {
  CancelRequest, CleanupRequest, ExecuteRequest, ExecutionLinks, NormalizedParameters,
} from "../../execution.js";
import { parseOperationId, parseRunId, parseTaskId, parseTestId } from "../../ids.js";
import { cloneSafeData, deepFreeze, readSafeRecordEnvelope } from "../../safe-data.js";
import type { WorkspaceSnapshot } from "../../workspace.js";
import { validateTestDefinition } from "../../validate-definition.js";
import { exactKeys } from "../../validation.js";

export function snapshotExecuteRequest(input: ExecuteRequest): Readonly<ExecuteRequest> {
  const value = readSafeRecordEnvelope(input, "ExecuteRequest");
  exactKeys(value, "ExecuteRequest",
    ["runId", "snapshot", "testId", "parameters", "definition", "workspace"],
    ["taskId", "executionLinks"]);
  const runId = parseRunId(value.runId);
  const testId = parseTestId(value.testId);
  const definition = validateTestDefinition(value.definition);
  if (definition.testId !== testId) throw new TypeError("ExecuteRequest definition testId does not match.");
  const workspace = snapshotWorkspace(value.workspace, "ExecuteRequest.workspace");
  const correlation = snapshotCorrelation(value.snapshot);
  if (correlation.snapshotId !== workspace.snapshotId ||
    correlation.resolvedRevision !== workspace.resolvedRevision) {
    throw new TypeError("ExecuteRequest snapshot correlation does not match the actual workspace.");
  }
  const parameters = safePlainClone(value.parameters, "ExecuteRequest.parameters") as NormalizedParameters;
  const taskId = value.taskId === undefined ? undefined : parseTaskId(value.taskId);
  const executionLinks = value.executionLinks === undefined ? undefined :
    safePlainClone(value.executionLinks, "ExecuteRequest.executionLinks") as unknown as ExecutionLinks;
  return Object.freeze({ runId, snapshot: correlation, testId, parameters, definition, workspace,
    ...(taskId === undefined ? {} : { taskId }),
    ...(executionLinks === undefined ? {} : { executionLinks }) });
}

export function snapshotCancelRequest(input: CancelRequest): Readonly<CancelRequest> {
  const value = readSafeRecordEnvelope(input, "CancelRequest");
  exactKeys(value, "CancelRequest", ["runId", "reason"]);
  return Object.freeze({ runId: parseRunId(value.runId), reason: text(value.reason, "CancelRequest.reason") });
}

export function snapshotCleanupRequest(input: CleanupRequest): Readonly<CleanupRequest> {
  const value = readSafeRecordEnvelope(input, "CleanupRequest");
  exactKeys(value, "CleanupRequest", ["runId", "snapshot"]);
  return Object.freeze({ runId: parseRunId(value.runId),
    snapshot: snapshotWorkspace(value.snapshot, "CleanupRequest.snapshot") });
}

export function requestFingerprint(request: Readonly<ExecuteRequest>): string {
  return stableStringify({ runId: request.runId, snapshot: request.snapshot, testId: request.testId,
    parameters: request.parameters, definition: request.definition, workspace: request.workspace,
    ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
    ...(request.executionLinks === undefined ? {} : { executionLinks: request.executionLinks }) });
}

export function sameWorkspaceIdentity(
  left: WorkspaceSnapshot, right: WorkspaceSnapshot,
): boolean {
  return left.operationId === right.operationId && left.snapshotId === right.snapshotId &&
    left.resolvedRevision === right.resolvedRevision && left.rootPath === right.rootPath;
}

function snapshotCorrelation(input: unknown): ExecuteRequest["snapshot"] {
  const value = readSafeRecordEnvelope(input, "ExecuteRequest.snapshot");
  exactKeys(value, "ExecuteRequest.snapshot", ["snapshotId", "resolvedRevision"]);
  return Object.freeze({ snapshotId: text(value.snapshotId, "snapshotId"),
    resolvedRevision: text(value.resolvedRevision, "resolvedRevision") });
}

function snapshotWorkspace(input: unknown, label: string): WorkspaceSnapshot {
  const value = readSafeRecordEnvelope(input, label);
  exactKeys(value, label, ["operationId", "snapshotId", "resolvedRevision", "rootPath",
    "runtimeMetadata", "autMetadata"]);
  const rootPath = text(value.rootPath, `${label}.rootPath`);
  if (!path.isAbsolute(rootPath) || rootPath.includes("\0")) {
    throw new TypeError(`${label}.rootPath must be an absolute path without NUL.`);
  }
  return Object.freeze({ operationId: parseOperationId(value.operationId),
    snapshotId: text(value.snapshotId, `${label}.snapshotId`),
    resolvedRevision: text(value.resolvedRevision, `${label}.resolvedRevision`), rootPath,
    runtimeMetadata: stringRecord(value.runtimeMetadata, `${label}.runtimeMetadata`),
    autMetadata: stringRecord(value.autMetadata, `${label}.autMetadata`) });
}

function stringRecord(input: unknown, label: string): Readonly<Record<string, string>> {
  const clone = safePlainClone(input, label);
  for (const [key, value] of Object.entries(clone)) {
    if (typeof value !== "string") throw new TypeError(`${label}.${key} must be a string.`);
  }
  return clone as Readonly<Record<string, string>>;
}

function safePlainClone(input: unknown, label: string): Readonly<Record<string, unknown>> {
  const clone = cloneSafeData(input);
  const value = readSafeRecordEnvelope(clone, label);
  return deepFreeze(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL.`);
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
