import type { Artifact, RunResult, RunStatus } from "../execution.js";
import { parseRunId, parseTaskId, parseTestId } from "../ids.js";
import { cloneSafeData, deepFreeze, readSafeArrayEnvelope, readSafeRecordEnvelope } from "../safe-data.js";
import type { CleanupReceipt } from "../workspace.js";
import type { StoredRunRecord } from "./contracts.js";
import { StoreCorruptionError } from "./contracts.js";

const statuses = new Set<RunStatus>([
  "queued", "preparing", "running", "cancelling", "completed", "failed", "cancelled", "interrupted",
]);

export function parseStoredRun(input: unknown): StoredRunRecord {
  try {
    const clone = cloneSafeData(input);
    const value = readSafeRecordEnvelope(clone, "StoredRunRecord");
    if (value.schemaVersion !== "surfaceloom.service-run/v1") fail("Unsupported run schema.");
    const revision = integer(value.revision, "revision");
    const requestId = requestKey(value.requestId);
    const fingerprint = sha(value.fingerprint, "fingerprint");
    const runId = parseRunId(value.runId);
    const testId = parseTestId(value.testId);
    const status = runStatus(value.status);
    const snapshot = stringPair(value.snapshot, "snapshotId", "resolvedRevision");
    const parameters = record(value.parameters, "parameters");
    const artifacts = readSafeArrayEnvelope(value.artifacts, "artifacts").map(parseArtifact);
    const result = value.result === undefined ? undefined : parseResult(value.result, runId, status);
    const cleanup = value.cleanup === undefined ? undefined : parseCleanup(value.cleanup, runId);
    const workspaceRelease = value.workspaceRelease === undefined ? undefined :
      parseCleanup(value.workspaceRelease, runId);
    return deepFreeze({ schemaVersion: "surfaceloom.service-run/v1", revision, requestId, fingerprint,
      runId, snapshot, testId, parameters, status,
      outcome: outcome(value.outcome), artifacts,
      createdAt: timestamp(value.createdAt, "createdAt"), updatedAt: timestamp(value.updatedAt, "updatedAt"),
      ...(value.startedAt === undefined ? {} : { startedAt: timestamp(value.startedAt, "startedAt") }),
      ...(value.finishedAt === undefined ? {} : { finishedAt: timestamp(value.finishedAt, "finishedAt") }),
      ...(value.taskId === undefined ? {} : { taskId: parseTaskId(value.taskId) }),
      ...(value.executionLinks === undefined ? {} : { executionLinks: record(value.executionLinks, "executionLinks") as unknown as StoredRunRecord["executionLinks"] }),
      ...(result === undefined ? {} : { result }),
      ...(value.error === undefined ? {} : { error: parseError(value.error) }),
      ...(cleanup === undefined ? {} : { cleanup }),
      ...(workspaceRelease === undefined ? {} : { workspaceRelease }),
      tainted: boolean(value.tainted, "tainted") }) as StoredRunRecord;
  } catch (cause) {
    if (cause instanceof StoreCorruptionError) throw cause;
    throw new StoreCorruptionError("Persisted run record failed validation.", { cause });
  }
}

export function parseArtifact(input: unknown): Artifact {
  const value = readSafeRecordEnvelope(input, "Artifact");
  return deepFreeze({ artifactId: text(value.artifactId, "artifactId"),
    runId: parseRunId(value.runId), name: text(value.name, "name"),
    mediaType: text(value.mediaType, "mediaType"), sizeBytes: integer(value.sizeBytes, "sizeBytes"),
    sha256: sha(value.sha256, "sha256") });
}

export function parseCleanup(input: unknown, runId?: string): CleanupReceipt {
  const value = readSafeRecordEnvelope(input, "CleanupReceipt");
  const status = value.status;
  if (status !== "confirmed" && status !== "unconfirmed" && status !== "not-required") fail("Invalid cleanup status.");
  const parsedRun = value.runId === undefined ? undefined : parseRunId(value.runId);
  if (runId !== undefined && parsedRun !== undefined && parsedRun !== runId) fail("Cleanup run mismatch.");
  return deepFreeze({ ...(parsedRun === undefined ? {} : { runId: parsedRun }),
    snapshotId: text(value.snapshotId, "snapshotId"), status,
    tainted: boolean(value.tainted, "tainted"), attemptedAt: timestamp(value.attemptedAt, "attemptedAt"),
    ...(value.detail === undefined ? {} : { detail: text(value.detail, "detail") }) });
}

function parseResult(input: unknown, runId: string, status: RunStatus): RunResult {
  const value = record(input, "result");
  if (parseRunId(value.runId) !== runId) fail("Result run mismatch.");
  const execution = value.executionStatus;
  if (execution !== "completed" && execution !== "failed" && execution !== "cancelled" && execution !== "interrupted") fail("Invalid result execution status.");
  if (execution !== status) fail("Stored status and result status differ.");
  parseCleanup(value.cleanup, runId);
  return deepFreeze(value) as unknown as RunResult;
}

function parseError(input: unknown) {
  const value = readSafeRecordEnvelope(input, "ExecutionError");
  return deepFreeze({ code: text(value.code, "error.code"), message: text(value.message, "error.message"),
    retryable: boolean(value.retryable, "error.retryable") });
}

function stringPair(input: unknown, first: string, second: string) {
  const value = readSafeRecordEnvelope(input, "snapshot");
  return deepFreeze({ [first]: text(value[first], first), [second]: text(value[second], second) }) as
    Readonly<{ snapshotId: string; resolvedRevision: string }>;
}

function runStatus(value: unknown): RunStatus {
  if (typeof value !== "string" || !statuses.has(value as RunStatus)) fail("Invalid run status.");
  return value as RunStatus;
}

function outcome(value: unknown): StoredRunRecord["outcome"] {
  if (value === null || value === "passed" || value === "failed" || value === "skipped" ||
    value === "unsupported" || value === "unknown") return value;
  return fail("Invalid business outcome.");
}

function requestKey(value: unknown): string {
  const result = text(value, "requestId");
  if (Buffer.byteLength(result, "utf8") > 256) fail("requestId is too large.");
  return result;
}

function sha(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{64}$/u.test(result)) fail(`${label} is not SHA-256.`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (new Date(result).toISOString() !== result) fail(`${label} is not canonical ISO time.`);
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  return readSafeRecordEnvelope(value, label);
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative integer.`);
  return value as number;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be boolean.`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail(`${label} must be text.`);
  return value;
}

function fail(message: string): never { throw new StoreCorruptionError(message); }
