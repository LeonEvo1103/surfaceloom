import type {
  CancelResult, ExecuteRequest, ExecutionError, Executor,
} from "./execution.js";
import { createRunId, type RunId } from "./ids.js";
import { fingerprintExecuteRequest } from "./request-fingerprint.js";
import {
  cleanupIsSafe, failClosedCleanup, interruptionCleanup, isTerminal, waitBounded,
  workspaceReleaseFailure,
} from "./run-lifecycle.js";
import type {
  ArtifactStore, PutArtifactRequest, RunStore, StoredArtifact, StoredRunRecord,
} from "./stores/contracts.js";
import { snapshotExecuteRequest } from "./executors/command/request-snapshot.js";
import type { CleanupReceipt, WorkspaceSnapshot } from "./workspace.js";
import type { WorkspaceLease } from "./workspaces/contracts.js";

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
  readonly workspaceLifecycle?: PersistentWorkspaceLifecycle;
  readonly cancelTimeoutMs?: number;
  readonly now?: () => Date;
  readonly createRunId?: () => RunId;
}

export interface PersistentWorkspaceLifecycle {
  acquireLease(snapshot: WorkspaceSnapshot, runId: RunId): WorkspaceLease;
  completeLease(lease: WorkspaceLease, cleanup: CleanupReceipt): void;
  release(snapshot: WorkspaceSnapshot, signal: AbortSignal): Promise<CleanupReceipt>;
}

interface ActiveRun {
  readonly abort: AbortController;
  readonly promise: Promise<void>;
  cancelPromise?: Promise<CancelResult>;
}

/** Minimal durable coordinator used by transports such as the later MCP adapter. */
export class PersistentRunService {
  readonly #runs: RunStore;
  readonly #artifacts: ArtifactStore;
  readonly #executor: Executor;
  readonly #workspaceLifecycle: PersistentWorkspaceLifecycle | undefined;
  readonly #cancelTimeoutMs: number;
  readonly #now: () => Date;
  readonly #createRunId: () => RunId;
  readonly #active = new Map<RunId, ActiveRun>();

  private constructor(options: PersistentRunServiceOptions) {
    this.#runs = options.runStore;
    this.#artifacts = options.artifactStore;
    this.#executor = options.executor;
    this.#workspaceLifecycle = options.workspaceLifecycle;
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
      fingerprint: fingerprintExecuteRequest(request), proposedRunId, snapshot: request.snapshot,
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

  getByRequestId(requestId: string): Promise<StoredRunRecord | undefined> {
    return this.#runs.getByRequestId(requestId);
  }

  get executorId(): string { return this.#executor.id; }

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
    if (active.cancelPromise === undefined) {
      const cancellation = this.#cancelActive(runId, reason, active);
      active.cancelPromise = cancellation;
      void cancellation.catch(() => {
        if (active.cancelPromise === cancellation) delete active.cancelPromise;
      });
    }
    return active.cancelPromise;
  }

  async #cancelActive(runId: RunId, reason: string, active: ActiveRun): Promise<CancelResult> {
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
    let lease: WorkspaceLease | undefined;
    let leaseCompleted = false;
    try {
      lease = this.#workspaceLifecycle?.acquireLease(request.workspace, request.runId);
      await this.#runs.markRunning(request.runId, this.#timestamp());
      let result = await this.#executor.execute(request, signal);
      const current = await this.#runs.get(request.runId);
      if (current === undefined) return;
      if (isTerminal(current.status)) {
        if (lease !== undefined && current.cleanup !== undefined) {
          this.#workspaceLifecycle?.completeLease(lease, current.cleanup);
        }
        return;
      }
      result = failClosedCleanup(result);
      let workspaceRelease: CleanupReceipt | undefined;
      if (lease !== undefined) {
        this.#workspaceLifecycle?.completeLease(lease, result.cleanup);
        leaseCompleted = true;
        if (cleanupIsSafe(result.cleanup)) {
          workspaceRelease = await this.#releaseWorkspace(request.workspace, request.runId);
          if (workspaceRelease !== undefined &&
            !cleanupIsSafe(workspaceRelease)) {
            result = workspaceReleaseFailure(result, workspaceRelease);
          }
        }
      }
      await this.#runs.finish(request.runId, result, workspaceRelease);
    } catch (cause) {
      const cleanup = interruptionCleanup(request.runId, request.snapshot.snapshotId,
        this.#timestamp());
      try {
        await this.#interrupt(request.runId, "executor_failed",
          cause instanceof Error ? cause.message : "Executor failed without a structured result.",
          cleanup);
      } finally {
        if (lease !== undefined && !leaseCompleted) {
          this.#workspaceLifecycle?.completeLease(lease, cleanup);
        }
      }
    }
  }

  async #releaseWorkspace(snapshot: WorkspaceSnapshot, runId: RunId): Promise<CleanupReceipt | undefined> {
    const lifecycle = this.#workspaceLifecycle;
    if (lifecycle === undefined) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ readonly timedOut: true }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort("Workspace release deadline elapsed.");
        resolve({ timedOut: true });
      }, this.#cancelTimeoutMs);
    });
    const release = lifecycle.release(snapshot, controller.signal).then(
      value => ({ value }),
      error => ({ error }),
    );
    const settled = await Promise.race([release, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if ("timedOut" in settled) {
      return Object.freeze({ runId, snapshotId: snapshot.snapshotId,
        status: "unconfirmed", tainted: true, attemptedAt: this.#timestamp(),
        detail: "Workspace release did not settle before its deadline." });
    }
    if ("error" in settled) throw settled.error;
    return settled.value;
  }

  async #interrupt(runId: RunId, code: string, message: string,
    cleanup?: CleanupReceipt): Promise<void> {
    const record = await this.#runs.get(runId);
    if (record === undefined || isTerminal(record.status)) return;
    const error: ExecutionError = Object.freeze({ code, message, retryable: true });
    await this.#runs.interrupt(runId, error, cleanup ?? interruptionCleanup(runId,
      record.snapshot.snapshotId, this.#timestamp()), this.#timestamp());
  }

  #timestamp(): string { return this.#now().toISOString(); }
}
