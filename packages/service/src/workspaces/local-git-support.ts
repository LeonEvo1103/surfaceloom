import path from "node:path";

import { parseOperationId, parseRunId, type RunId } from "../ids.js";
import { cloneSafeData, deepFreeze } from "../safe-data.js";
import type {
  CleanupReceipt,
  PrepareWorkspaceRequest,
  WorkspaceSnapshot,
} from "../workspace.js";
import type { WorkspaceCommandRunner, WorkspaceLease } from "./contracts.js";
import { WorkspacePreparationError } from "./contracts.js";
import type { DirectoryIdentity } from "./path-safety.js";

export interface LocalGitWorkspaceProviderOptions {
  readonly sourceRoot: string;
  readonly snapshotRoot: string;
  readonly gitBinary?: string;
  readonly commandRunner?: WorkspaceCommandRunner;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
}

export interface SnapshotState {
  readonly snapshot: WorkspaceSnapshot;
  readonly directoryIdentity: DirectoryIdentity;
  readonly snapshotRootIdentity: DirectoryIdentity;
  activeLease?: WorkspaceLease;
  lastRunId?: RunId;
  quarantined: boolean;
  releaseToken?: number;
  releasePromise?: Promise<CleanupReceipt>;
}

export function readRequest(request: PrepareWorkspaceRequest): PrepareWorkspaceRequest {
  let value: PrepareWorkspaceRequest;
  try {
    value = cloneSafeData(request);
  } catch (error) {
    throw new WorkspacePreparationError("invalid-request", "Workspace request is not safe data.", { cause: error });
  }
  assertExactKeys(
    value as unknown as Record<string, unknown>,
    ["operationId", "source", "revision"],
    [],
    "invalid-request",
  );
  parseOperationId(value.operationId);
  if (typeof value.revision !== "string" || value.revision.trim().length === 0
    || value.revision.length > 200 || /[\0\r\n]/u.test(value.revision)) {
    throw new WorkspacePreparationError("invalid-request", "Workspace revision is invalid.");
  }
  if (typeof value.source?.provider !== "string" || typeof value.source.locator !== "string") {
    throw new WorkspacePreparationError("invalid-request", "Workspace source is invalid.");
  }
  assertExactKeys(
    value.source as unknown as Record<string, unknown>,
    ["provider", "locator"],
    [],
    "invalid-request",
  );
  return value;
}

export function readCleanup(cleanup: CleanupReceipt, lease: WorkspaceLease): CleanupReceipt {
  let value: CleanupReceipt;
  try {
    value = cloneSafeData(cleanup);
  } catch (error) {
    throw new WorkspacePreparationError(
      "snapshot-unsafe",
      "Workspace cleanup evidence is not safe data.",
      { cause: error },
    );
  }
  assertExactKeys(value as unknown as Record<string, unknown>, [
    "runId", "snapshotId", "status", "tainted", "attemptedAt",
  ], ["detail"], "snapshot-unsafe");
  let runId: RunId;
  try {
    runId = parseRunId(value.runId);
  } catch (error) {
    throw new WorkspacePreparationError("snapshot-unsafe", "Workspace cleanup runId is invalid.", { cause: error });
  }
  if (runId !== lease.runId || value.snapshotId !== lease.snapshotId) {
    throw new WorkspacePreparationError(
      "snapshot-unsafe",
      "Workspace cleanup evidence does not match its lease identities.",
    );
  }
  if (!["confirmed", "unconfirmed", "not-required"].includes(value.status)
    || typeof value.tainted !== "boolean"
    || typeof value.attemptedAt !== "string"
    || !Number.isFinite(Date.parse(value.attemptedAt))
    || (value.detail !== undefined && typeof value.detail !== "string")) {
    throw new WorkspacePreparationError("snapshot-unsafe", "Workspace cleanup evidence is invalid.");
  }
  return value;
}

export function normalizeError(cause: unknown, signal: AbortSignal): WorkspacePreparationError {
  if (cause instanceof WorkspacePreparationError) return cause;
  return new WorkspacePreparationError(
    signal.aborted ? "aborted" : "prepare-failed",
    signal.aborted ? "Workspace preparation was aborted." : "Workspace preparation failed.",
    { cause },
  );
}

export function freezeSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  return deepFreeze(cloneSafeData(snapshot)) as WorkspaceSnapshot;
}

export function workspaceTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Workspace clock must return a valid Date.");
  }
  return value.toISOString();
}

export function cleanupReceipt(
  state: SnapshotState,
  attemptedAt: string,
  status: "confirmed" | "unconfirmed",
  tainted: boolean,
  detail?: string,
): CleanupReceipt {
  return Object.freeze({
    ...(state.lastRunId === undefined ? {} : { runId: state.lastRunId }),
    snapshotId: state.snapshot.snapshotId,
    status,
    tainted,
    attemptedAt,
    ...(detail === undefined ? {} : { detail }),
  });
}

export function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  const reverse = path.relative(right, left);
  return relative === "" || isDescendant(relative) || isDescendant(reverse);
}

function isDescendant(relative: string): boolean {
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  code: "invalid-request" | "snapshot-unsafe",
): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw new WorkspacePreparationError(code, "Workspace data has missing or unknown fields.");
  }
}
