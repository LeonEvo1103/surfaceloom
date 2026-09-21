import { createHash } from "node:crypto";

import type {
  CancelResult, ExecuteRequest, ExecutionError, Executor,
} from "./execution.js";
import { createRunId, type RunId } from "./ids.js";
import { cloneSafeData } from "./safe-data.js";
import type {
  ArtifactStore, PutArtifactRequest, RunStore, StoredArtifact, StoredRunRecord,
} from "./stores/contracts.js";
import { snapshotExecuteRequest } from "./executors/command/request-snapshot.js";

export type StartRunRequest = Omit<ExecuteRequest, "runId"> & { readonly requestId: string };

export interface StartRunResult {
  readonly runId: RunId;
  readonly status: StoredRunRecord["status"];
  readonly reused: boolean;
}

export interface PersistentRunServiceOptions {
  readonly runStore: RunStore;
  readonly artifactStore: ArtifactStore;
  readonly executor: Executor;
  readonly cancelTimeoutMs?: number;
  readonly now?: () => Date;
  readonly createRunId?: () => RunId;
}

interface ActiveRun {
  readonly abort: AbortController;
  readonly promise: Promise<void>;
}

/** Minimal durable coordinator used by transports such as the later MCP adapter. */
export class PersistentRunService {
  readonly #runs: RunStore;
  readonly #artifacts: ArtifactStore;
  readonly #executor: Executor;
  readonly #cancelTimeoutMs: number;
  readonly #now: () => Date;
  readonly #createRunId: () => RunId;
  readonly #active = new Map<RunId, ActiveRun>();

  private constructor(options: PersistentRunServiceOptions) {
    this.#runs = options.runStore;
    this.#artifacts = options.artifactStore;
    this.#executor = options.executor;
    this.#cancelTimeoutMs = options.cancelTimeoutMs ?? 5_000;
    this.#now = options.now ?? (() => new Date());
    this.#createRunId = options.createRunId ?? createRunId;
    if (!Number.isSafeInteger(this.#cancelTimeoutMs) || this.#cancelTimeoutMs <= 0) {
      throw new TypeError("cancelTimeoutMs must be a positive integer.");
    }
  }

  static async create(options: PersistentRunServiceOptions): Promise<PersistentRunService> {
    const service = new PersistentRunService(options);
    await service.#runs.recoverInterrupted(service.#timestamp());
    return service;
  }

  async start(input: StartRunRequest): Promise<StartRunResult> {
    const proposedRunId = this.#createRunId();
    const { requestId, ...execution } = input;
    const request = snapshotExecuteRequest({ ...execution, runId: proposedRunId });
    const reservation = await this.#runs.reserve({ requestId,
      fingerprint: fingerprint(request), proposedRunId, snapshot: request.snapshot,
      testId: request.testId, parameters: request.parameters,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(request.executionLinks === undefined ? {} : { executionLinks: request.executionLinks }),
      createdAt: this.#timestamp() });
    if (!reservation.created) return Object.freeze({ runId: reservation.record.runId,
      status: reservation.record.status, reused: true });

    const abort = new AbortController();
    const promise = this.#dispatch(request, abort.signal).finally(() => {
      this.#active.delete(request.runId);
    });
    this.#active.set(request.runId, { abort, promise });
    void promise.catch(() => undefined);
    return Object.freeze({ runId: request.runId, status: "queued", reused: false });
  }

  get(runId: RunId): Promise<StoredRunRecord | undefined> { return this.#runs.get(runId); }

  async wait(runId: RunId): Promise<StoredRunRecord | undefined> {
    const active = this.#active.get(runId);
    if (active !== undefined) await active.promise;
    return this.#runs.get(runId);
  }

  async cancel(runId: RunId, reason: string): Promise<CancelResult> {
    const record = await this.#runs.get(runId);
    if (record === undefined) return Object.freeze({ runId, disposition: "not-found" });
    if (isTerminal(record.status)) return Object.freeze({ runId, disposition: "already-terminal" });
    const active = this.#active.get(runId);
    if (active === undefined) {
      await this.#interrupt(runId, "executor_lost", "No live executor owns the persisted run.");
      return Object.freeze({ runId, disposition: "accepted" });
    }
    await this.#runs.markCancelling(runId, this.#timestamp());
    active.abort.abort(reason);
    const cancelAbort = new AbortController();
    const timer = setTimeout(() => cancelAbort.abort("Cancel request deadline elapsed."), this.#cancelTimeoutMs);
    const cancel = this.#executor.cancel({ runId, reason }, cancelAbort.signal).catch(() => undefined);
    const settled = await waitBounded(Promise.allSettled([cancel, active.promise]), this.#cancelTimeoutMs);
    clearTimeout(timer);
    if (!settled) await this.#interrupt(runId, "cancel_cleanup_timeout",
      "Cancellation did not reach a confirmed terminal state before its deadline.");
    return Object.freeze({ runId, disposition: "accepted" });
  }

  async putArtifact(request: PutArtifactRequest): Promise<StoredRunRecord> {
    const artifact = await this.#artifacts.put(request);
    return this.#runs.attachArtifact(request.runId, artifact, this.#timestamp());
  }

  getArtifact(artifactId: string): Promise<StoredArtifact | undefined> {
    return this.#artifacts.get(artifactId);
  }

  async close(): Promise<void> { await this.#runs.close(); }

  async #dispatch(request: Readonly<ExecuteRequest>, signal: AbortSignal): Promise<void> {
    try {
      await this.#runs.markRunning(request.runId, this.#timestamp());
      const result = await this.#executor.execute(request, signal);
      const current = await this.#runs.get(request.runId);
      if (current !== undefined && !isTerminal(current.status)) {
        await this.#runs.finish(request.runId, result);
      }
    } catch (cause) {
      await this.#interrupt(request.runId, "executor_failed",
        cause instanceof Error ? cause.message : "Executor failed without a structured result.");
    }
  }

  async #interrupt(runId: RunId, code: string, message: string): Promise<void> {
    const record = await this.#runs.get(runId);
    if (record === undefined || isTerminal(record.status)) return;
    const error: ExecutionError = Object.freeze({ code, message, retryable: true });
    await this.#runs.interrupt(runId, error, Object.freeze({ runId,
      snapshotId: record.snapshot.snapshotId, status: "unconfirmed", tainted: true,
      attemptedAt: this.#timestamp(), detail: "Owned process cleanup was not confirmed; workspace must remain quarantined." }),
    this.#timestamp());
  }

  #timestamp(): string { return this.#now().toISOString(); }
}

function fingerprint(request: Readonly<ExecuteRequest>): string {
  const { runId: _runId, ...stable } = request;
  return createHash("sha256").update(stableStringify(cloneSafeData(stable))).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function isTerminal(status: StoredRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

async function waitBounded(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
