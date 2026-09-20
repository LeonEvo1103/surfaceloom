import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type {
  CancelRequest, CancelResult, CleanupRequest, ExecuteRequest, Executor,
} from "../../execution.js";
import type { RunId } from "../../ids.js";
import type { CleanupReceipt } from "../../workspace.js";
import { snapshotCommandConfig, type CommandConfig } from "./config.js";
import { cleanupProcessTree, launchOwnedProcess } from "./containment.js";
import type {
  CommandChild, CommandExecutorOptions, CommandRunResult, CommandSpawn, ProcessTreeHandle,
  RegisteredCommand, SignalAttemptReceipt,
} from "./contracts.js";
import { terminateOwnedProcess, waitBounded, waitForFirstEvent } from "./lifecycle.js";
import { ProcessObserver } from "./process-observer.js";
import { finishForEvent, finishLaunchFailure, noProcessResult } from "./results.js";
import {
  requestFingerprint, sameWorkspaceIdentity, snapshotCancelRequest,
  snapshotCleanupRequest, snapshotExecuteRequest,
} from "./request-snapshot.js";
import {
  defaultSpawn, errorMessage, identityMismatchCleanup, notRequiredCleanup,
  resolveRegisteredCwd, selectEnvironment,
} from "./runtime.js";

interface RunEntry {
  readonly fingerprint: string;
  readonly abort: AbortController;
  readonly promise: Promise<CommandRunResult>;
  readonly request: Readonly<ExecuteRequest>;
  terminal: boolean;
}

export class CommandExecutor implements Executor {
  readonly id: string;
  readonly #config: CommandConfig;
  readonly #spawn: CommandSpawn;
  readonly #monotonicNow: () => number;
  readonly #wallNow: () => Date;
  readonly #runs = new Map<RunId, RunEntry>();

  constructor(id: string, options: CommandExecutorOptions) {
    if (id.length === 0) throw new TypeError("Command executor id must not be empty.");
    this.id = id;
    this.#config = snapshotCommandConfig(options);
    this.#spawn = this.#config.spawn ?? defaultSpawn;
    this.#monotonicNow = this.#config.monotonicNow ?? (() => performance.now());
    this.#wallNow = this.#config.wallNow ?? (() => new Date());
  }

  execute(request: ExecuteRequest, signal: AbortSignal): Promise<CommandRunResult> {
    let snapshot: Readonly<ExecuteRequest>;
    try { snapshot = snapshotExecuteRequest(request); } catch (error) { return Promise.reject(error); }
    const fingerprint = requestFingerprint(snapshot);
    const existing = this.#runs.get(snapshot.runId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new Error(`runId ${snapshot.runId} was already used for another request.`));
      }
      return existing.promise;
    }
    const abort = new AbortController();
    const combined = AbortSignal.any([signal, abort.signal]);
    const promise = this.#run(snapshot, combined);
    const entry: RunEntry = { fingerprint, abort, promise, request: snapshot, terminal: false };
    void promise.then(
      () => { entry.terminal = true; },
      () => { entry.terminal = true; },
    );
    this.#runs.set(snapshot.runId, entry);
    return promise;
  }

  async cancel(request: CancelRequest, _signal: AbortSignal): Promise<CancelResult> {
    const snapshot = snapshotCancelRequest(request);
    const entry = this.#runs.get(snapshot.runId);
    if (entry === undefined) return { runId: snapshot.runId, disposition: "not-found" };
    if (entry.terminal) return { runId: snapshot.runId, disposition: "already-terminal" };
    entry.abort.abort(snapshot.reason);
    return { runId: snapshot.runId, disposition: "accepted" };
  }

  async cleanup(request: CleanupRequest, _signal: AbortSignal): Promise<CleanupReceipt> {
    const snapshot = snapshotCleanupRequest(request);
    const entry = this.#runs.get(snapshot.runId);
    if (entry === undefined) return notRequiredCleanup(snapshot, this.#wallNow);
    if (!sameWorkspaceIdentity(entry.request.workspace, snapshot.snapshot)) {
      return identityMismatchCleanup(snapshot, this.#wallNow);
    }
    entry.abort.abort("Explicit executor cleanup requested.");
    return (await entry.promise).cleanup;
  }

  async #run(request: ExecuteRequest, signal: AbortSignal): Promise<CommandRunResult> {
    const startedAt = this.#wallNow().toISOString();
    const command = this.#config.commands.get(request.testId);
    if (command === undefined || command.executorId !== request.definition.runtime.executorId ||
      command.executorId !== this.id) {
      return noProcessResult(request, command, startedAt, this.#wallNow, this.#monotonicNow(),
        "infrastructure", "failed", "command_not_registered",
        "No exact registered command matches this test and executor.");
    }
    const deadlineAt = this.#monotonicNow() + command.timeoutMs;
    if (signal.aborted) return cancelledBeforeSpawn(request, command, startedAt, deadlineAt, this.#wallNow);

    let cwd: string;
    let environment: Readonly<Record<string, string>>;
    try {
      cwd = await resolveRegisteredCwd(request.workspace.rootPath, command.cwd);
      environment = selectEnvironment(command, request, this.#config.environment);
    } catch (error) {
      return noProcessResult(request, command, startedAt, this.#wallNow, deadlineAt,
        "infrastructure", "failed", "command_policy_rejected", errorMessage(error));
    }
    if (signal.aborted) return cancelledBeforeSpawn(request, command, startedAt, deadlineAt, this.#wallNow);
    if (this.#monotonicNow() >= deadlineAt) {
      return noProcessResult(request, command, startedAt, this.#wallNow, deadlineAt,
        "deadline", "failed", "deadline_exceeded", "Command deadline elapsed before spawn.");
    }

    const instanceId = randomUUID();
    const observer = new ProcessObserver(
      instanceId, this.#config.maxStdoutBytes, this.#config.maxStderrBytes,
    );
    let child: CommandChild | undefined;
    let processTree: ProcessTreeHandle;
    try {
      const launched = launchOwnedProcess(this.#config.processTree, this.#spawn,
        command.executable, command.argv, {
        cwd, env: environment, shell: false, detached: false,
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      }, observer.identity(), (spawned) => {
        child = spawned;
        observer.attach(spawned);
      });
      processTree = launched.handle;
    } catch (error) {
      if (child !== undefined) {
        return this.#finishFailedLaunch(request, command, startedAt, deadlineAt, child, observer,
          errorMessage(error));
      }
      return noProcessResult(request, command, startedAt, this.#wallNow, deadlineAt,
        "infrastructure", "failed", "spawn_failed", errorMessage(error));
    }
    const runningChild = child;
    if (runningChild === undefined) {
      return noProcessResult(request, command, startedAt, this.#wallNow, deadlineAt,
        "infrastructure", "failed", "spawn_failed", "Spawn completed without a registered child.");
    }
    const first = waitForFirstEvent(
      observer.exitPromise, observer.failurePromise, signal, deadlineAt, this.#monotonicNow,
    );
    const event = await first.promise;
    first.dispose();
    const signals: readonly SignalAttemptReceipt[] = event.trigger === "natural" ? [] :
      await terminateOwnedProcess(runningChild, observer.exitPromise, () => observer.exitReceipt !== null,
        this.#config.terminateGraceMs, this.#config.forceKillWaitMs, this.#wallNow);
    if (observer.exitReceipt === null) {
      observer.settleUnconfirmed("Process exit was not observed before the cleanup deadline.");
    }
    // Tree cleanup can be the operation that releases inherited pipe handles. Give streams their
    // full bounded drain window after cleanup settles so its final output and EOF are observable.
    const processTreeReceipt = await cleanupProcessTree(processTree, this.#config.processTreeWaitMs);
    if (!observer.stdioTerminal) {
      await waitBounded(observer.stdioPromise, this.#config.stdioCloseWaitMs);
    }
    const result = finishForEvent(
      request, command, startedAt, deadlineAt, event.trigger, event.detail,
      observer, signals, processTreeReceipt, this.#wallNow,
    );
    if (result.command.cleanup.status === "unconfirmed") {
      runningChild.stdout.destroy();
      runningChild.stderr.destroy();
      runningChild.unref();
    }
    return result;
  }

  async #finishFailedLaunch(
    request: ExecuteRequest,
    command: RegisteredCommand,
    startedAt: string,
    deadlineAt: number,
    child: CommandChild,
    observer: ProcessObserver,
    detail: string,
  ): Promise<CommandRunResult> {
    const signals = await terminateOwnedProcess(child, observer.exitPromise,
      () => observer.exitReceipt !== null, this.#config.terminateGraceMs,
      this.#config.forceKillWaitMs, this.#wallNow);
    if (observer.exitReceipt === null) {
      observer.settleUnconfirmed("Process exit was not observed after process-tree launch failed.");
    }
    if (!observer.stdioTerminal) {
      await waitBounded(observer.stdioPromise, this.#config.stdioCloseWaitMs);
    }
    const processTree = Object.freeze({ status: "unconfirmed" as const,
      detail: "No validated process-tree handle was available after launch failed." });
    const result = finishLaunchFailure(request, command, startedAt, deadlineAt, detail, observer,
      signals, processTree, this.#wallNow);
    if (result.command.cleanup.status === "unconfirmed") {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
    return result;
  }

}

function cancelledBeforeSpawn(
  request: ExecuteRequest,
  command: Parameters<typeof noProcessResult>[1],
  startedAt: string,
  deadlineAt: number,
  wallNow: () => Date,
): CommandRunResult {
  return noProcessResult(request, command, startedAt, wallNow, deadlineAt, "abort",
    "cancelled", "command_cancelled", "Command was cancelled before spawn.");
}
