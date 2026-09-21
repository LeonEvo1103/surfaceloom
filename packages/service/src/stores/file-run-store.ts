import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Artifact, ExecutionError, RunResult } from "../execution.js";
import { parseRunId, type RunId } from "../ids.js";
import { cloneSafeData, deepFreeze } from "../safe-data.js";
import type { CleanupReceipt } from "../workspace.js";
import type {
  ReserveRunResult, RunReservation, RunStore, StoredRunRecord,
} from "./contracts.js";
import { StoreConflictError, StoreCorruptionError } from "./contracts.js";
import { parseArtifact, parseCleanup, parseStoredRun } from "./validation.js";

interface StoreFile { readonly schemaVersion: "surfaceloom.run-store/v1"; readonly runs: unknown[] }

const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);

export class FileRunStore implements RunStore {
  readonly #root: string;
  readonly #file: string;
  readonly #byRun = new Map<RunId, StoredRunRecord>();
  readonly #byRequest = new Map<string, RunId>();
  #tail: Promise<void> = Promise.resolve();

  private constructor(root: string) {
    this.#root = path.resolve(root);
    this.#file = path.join(this.#root, "runs.json");
  }

  static async open(root: string): Promise<FileRunStore> {
    const store = new FileRunStore(root);
    await mkdir(store.#root, { recursive: true, mode: 0o700 });
    await store.#load();
    return store;
  }

  reserve(input: RunReservation): Promise<ReserveRunResult> {
    return this.#mutate(async () => {
      const existingId = this.#byRequest.get(validateRequestId(input.requestId));
      if (existingId !== undefined) {
        const existing = this.#require(existingId);
        if (existing.fingerprint !== input.fingerprint) {
          throw new StoreConflictError("requestId was already used for a different run request.");
        }
        return deepFreeze({ created: false, record: existing });
      }
      if (this.#byRun.has(input.proposedRunId)) {
        throw new StoreConflictError("Proposed runId has already been used.");
      }
      const record = parseStoredRun({ schemaVersion: "surfaceloom.service-run/v1", revision: 0,
        requestId: input.requestId, fingerprint: input.fingerprint, runId: input.proposedRunId,
        snapshot: input.snapshot, testId: input.testId, parameters: input.parameters,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.executionLinks === undefined ? {} : { executionLinks: input.executionLinks }),
        status: "queued", outcome: null, artifacts: [], createdAt: input.createdAt,
        updatedAt: input.createdAt, tainted: false });
      this.#set(record);
      return deepFreeze({ created: true, record });
    });
  }

  async get(runId: RunId): Promise<StoredRunRecord | undefined> {
    await this.#tail;
    const value = this.#byRun.get(parseRunId(runId));
    return value === undefined ? undefined : clone(value);
  }

  async getByRequestId(requestId: string): Promise<StoredRunRecord | undefined> {
    await this.#tail;
    const runId = this.#byRequest.get(validateRequestId(requestId));
    return runId === undefined ? undefined : clone(this.#require(runId));
  }

  async list(): Promise<readonly StoredRunRecord[]> {
    await this.#tail;
    return Object.freeze([...this.#byRun.values()].map(clone));
  }

  markRunning(runId: RunId, startedAt: string): Promise<StoredRunRecord> {
    return this.#update(runId, (current) => {
      if (current.status !== "queued") throw transition(current, "running");
      return { ...current, revision: current.revision + 1, status: "running", startedAt,
        updatedAt: startedAt };
    });
  }

  markCancelling(runId: RunId, updatedAt: string): Promise<StoredRunRecord> {
    return this.#update(runId, (current) => {
      if (terminal.has(current.status)) return current;
      if (current.status !== "running" && current.status !== "queued") {
        throw transition(current, "cancelling");
      }
      return { ...current, revision: current.revision + 1, status: "cancelling", updatedAt };
    });
  }

  finish(runId: RunId, result: RunResult, workspaceRelease?: CleanupReceipt): Promise<StoredRunRecord> {
    return this.#update(runId, (current) => {
      if (terminal.has(current.status)) throw transition(current, result.executionStatus);
      const safe = cloneSafeData(result) as RunResult;
      if (safe.runId !== current.runId || safe.snapshot.snapshotId !== current.snapshot.snapshotId) {
        throw new StoreConflictError("Run result correlation does not match the persisted run.");
      }
      const release = workspaceRelease === undefined ? undefined : parseCleanup(workspaceRelease, runId);
      const artifacts = mergeArtifacts(current.artifacts, safe.artifacts);
      return { ...current, revision: current.revision + 1, status: safe.executionStatus,
        outcome: safe.outcome, artifacts, updatedAt: safe.finishedAt, finishedAt: safe.finishedAt,
        result: { ...safe, artifacts },
        ...(safe.executionStatus === "completed" ? {} : { error: safe.error }),
        cleanup: safe.cleanup, ...(release === undefined ? {} : { workspaceRelease: release }),
        tainted: safe.cleanup.tainted || release?.tainted === true };
    });
  }

  interrupt(runId: RunId, error: ExecutionError, cleanup: CleanupReceipt,
    finishedAt: string): Promise<StoredRunRecord> {
    return this.#update(runId, (current) => {
      if (terminal.has(current.status)) return current;
      const safeCleanup = parseCleanup(cleanup, runId);
      const result: RunResult = { runId: current.runId, snapshot: current.snapshot,
        testId: current.testId, parameters: current.parameters,
        ...(current.taskId === undefined ? {} : { taskId: current.taskId }),
        ...(current.executionLinks === undefined ? {} : { executionLinks: current.executionLinks }),
        startedAt: current.startedAt ?? current.createdAt, finishedAt,
        artifacts: current.artifacts, cleanup: safeCleanup, executionStatus: "interrupted",
        outcome: null, error: cloneSafeData(error) };
      return { ...current, revision: current.revision + 1, status: "interrupted", outcome: null,
        updatedAt: finishedAt, finishedAt, result, error: cloneSafeData(error),
        cleanup: safeCleanup, tainted: true };
    });
  }

  attachArtifact(runId: RunId, artifact: Artifact, updatedAt: string): Promise<StoredRunRecord> {
    return this.#update(runId, (current) => {
      if (terminal.has(current.status)) throw new StoreConflictError("Terminal runs are immutable.");
      const safe = parseArtifact(artifact);
      if (safe.runId !== current.runId) throw new StoreConflictError("Artifact runId does not match.");
      return { ...current, revision: current.revision + 1,
        artifacts: mergeArtifacts(current.artifacts, [safe]), updatedAt };
    });
  }

  recoverInterrupted(now: string): Promise<readonly StoredRunRecord[]> {
    return this.#mutate(async () => {
      const recovered: StoredRunRecord[] = [];
      for (const record of [...this.#byRun.values()]) {
        if (terminal.has(record.status)) continue;
        const cleanup = recoveryCleanup(record, now);
        const error = { code: "service_restarted", message: "Service restarted before the run reached a terminal state.", retryable: true };
        const result: RunResult = { runId: record.runId, snapshot: record.snapshot,
          testId: record.testId, parameters: record.parameters,
          ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
          ...(record.executionLinks === undefined ? {} : { executionLinks: record.executionLinks }),
          startedAt: record.startedAt ?? record.createdAt, finishedAt: now,
          artifacts: record.artifacts, cleanup, executionStatus: "interrupted", outcome: null, error };
        const next = parseStoredRun(detach({ ...record, revision: record.revision + 1,
          status: "interrupted", outcome: null, updatedAt: now, finishedAt: now,
          result, error, cleanup, tainted: true }));
        this.#set(next);
        recovered.push(next);
      }
      return Object.freeze(recovered.map(clone));
    }, recovered => recovered.length > 0);
  }

  async close(): Promise<void> { await this.#tail; }

  #update(runId: RunId, change: (current: StoredRunRecord) => StoredRunRecord): Promise<StoredRunRecord> {
    return this.#mutate(async () => {
      const next = parseStoredRun(detach(change(this.#require(parseRunId(runId)))));
      this.#set(next);
      return clone(next);
    });
  }

  #mutate<T>(operation: () => Promise<T>, changed: (value: T) => boolean = () => true): Promise<T> {
    const next = this.#tail.then(async () => {
      const value = await operation();
      if (changed(value)) await this.#persist();
      return value;
    });
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }

  async #load(): Promise<void> {
    let input: string;
    try { input = await readFile(this.#file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (Buffer.byteLength(input, "utf8") > 16 * 1024 * 1024) throw new StoreCorruptionError("Run store is too large.");
    const value = JSON.parse(input) as StoreFile;
    if (value.schemaVersion !== "surfaceloom.run-store/v1" || !Array.isArray(value.runs)) {
      throw new StoreCorruptionError("Run store header is invalid.");
    }
    for (const item of value.runs) this.#set(parseStoredRun(item));
  }

  async #persist(): Promise<void> {
    const temporary = path.join(this.#root, `.runs.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: "surfaceloom.run-store/v1",
      runs: [...this.#byRun.values()] })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, this.#file);
  }

  #set(record: StoredRunRecord): void {
    const requestOwner = this.#byRequest.get(record.requestId);
    if (requestOwner !== undefined && requestOwner !== record.runId) throw new StoreCorruptionError("Duplicate requestId.");
    this.#byRun.set(record.runId, record);
    this.#byRequest.set(record.requestId, record.runId);
  }

  #require(runId: RunId): StoredRunRecord {
    const value = this.#byRun.get(runId);
    if (value === undefined) throw new StoreConflictError(`Unknown runId ${runId}.`);
    return value;
  }
}

function clone(value: StoredRunRecord): StoredRunRecord { return parseStoredRun(cloneSafeData(value)); }
function detach(value: unknown): unknown { return JSON.parse(JSON.stringify(value)); }
function validateRequestId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256) throw new TypeError("requestId must be 1..256 UTF-8 bytes.");
  return value;
}
function transition(current: StoredRunRecord, next: string): StoreConflictError {
  return new StoreConflictError(`Cannot transition run from ${current.status} to ${next}.`);
}
function mergeArtifacts(left: readonly Artifact[], right: readonly Artifact[]): readonly Artifact[] {
  const values = new Map(left.map(item => [item.artifactId, item]));
  for (const item of right) values.set(item.artifactId, parseArtifact(item));
  return Object.freeze([...values.values()]);
}
function recoveryCleanup(record: StoredRunRecord, now: string): CleanupReceipt {
  return Object.freeze({ runId: record.runId, snapshotId: record.snapshot.snapshotId,
    status: "unconfirmed", tainted: true, attemptedAt: now,
    detail: "Service restart left process cleanup unconfirmed; workspace remains quarantined." });
}
