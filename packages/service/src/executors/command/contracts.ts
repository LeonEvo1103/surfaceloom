import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import type { RunResult } from "../../execution.js";
import type { TestId } from "../../ids.js";

export interface RegisteredCommand {
  readonly testId: TestId;
  readonly executorId: string;
  /** Absolute executable path. It is never supplied by a run request. */
  readonly executable: string;
  /** Exact argv registered by the service. Parameters are not interpolated. */
  readonly argv: readonly string[];
  /** Exact repository-relative cwd selected from the executor allowlist. */
  readonly cwd: string;
  /** Names selected from the executor environment allowlist. */
  readonly inheritEnvironment: readonly string[];
  readonly timeoutMs: number;
  readonly exitCodes: {
    readonly passed: readonly number[];
    readonly failed: readonly number[];
  };
}

export interface CommandExecutorOptions {
  readonly commands: readonly RegisteredCommand[];
  readonly allowedCwds: readonly string[];
  readonly allowedEnvironment: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly terminateGraceMs?: number;
  readonly forceKillWaitMs?: number;
  readonly stdioCloseWaitMs?: number;
  readonly processTreeWaitMs?: number;
  readonly spawn?: CommandSpawn;
  /** Platform adapter (for example a Windows Job or another owned process container). */
  readonly processTree?: ProcessTreeController;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => Date;
}

export type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

export interface CommandSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly detached: false;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
  readonly windowsHide: true;
}

export type CommandSpawn = (
  executable: string,
  argv: readonly string[],
  options: CommandSpawnOptions,
) => CommandChild;

export interface ProcessTreeController {
  /**
   * Synchronously owns the creation boundary so containment exists before descendants escape.
   * The supplied spawn capability expires when launch returns or throws; launch must not be async.
   */
  launch(
    spawn: CommandSpawn,
    executable: string,
    argv: readonly string[],
    options: CommandSpawnOptions,
    identity: ProcessIdentityReceipt,
  ): ProcessTreeLaunch;
}

export interface ProcessTreeLaunch {
  readonly child: CommandChild;
  readonly handle: ProcessTreeHandle;
}

export interface ProcessTreeHandle {
  /** Must terminate/reap the owned tree and confirm that no owned descendant remains. */
  cleanup(signal: AbortSignal): Promise<ProcessTreeReceipt>;
}

export type ProcessTreeReceipt =
  | { readonly status: "confirmed" }
  | { readonly status: "unconfirmed"; readonly detail: string }
  | { readonly status: "not-required" };

export interface ProcessIdentityReceipt {
  readonly instanceId: string;
  readonly status: "not-spawned" | "spawn-observed" | "spawn-unconfirmed";
  readonly pid: number | null;
}

export interface SignalAttemptReceipt {
  readonly signal: "SIGTERM" | "SIGKILL";
  readonly attemptedAt: string;
  readonly outcome: "accepted" | "rejected" | "threw";
  readonly detail?: string;
}

export type ProcessExitReceipt =
  | { readonly status: "not-spawned" }
  | {
      readonly status: "exited";
      readonly instanceId: string;
      readonly pid: number | null;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly status: "unconfirmed"; readonly detail: string };

export interface OutputReceipt {
  readonly text: string;
  readonly bytesSeen: number;
  readonly bytesRetained: number;
  readonly truncated: boolean;
  readonly terminal: boolean;
  readonly error?: string;
}

export interface StdioReceipt {
  readonly stdout: OutputReceipt;
  readonly stderr: OutputReceipt;
  readonly childCloseObserved: boolean;
}

export interface ProcessCleanupReceipt {
  readonly status: "confirmed" | "unconfirmed" | "not-required";
  readonly tainted: boolean;
  readonly processTree: ProcessTreeReceipt;
  readonly detail?: string;
}

export interface CommandExecutionReceipt {
  readonly registration:
    | {
        readonly status: "registered";
        readonly testId: TestId;
        readonly executorId: string;
        readonly executable: string;
        readonly argv: readonly string[];
        readonly cwd: string;
        readonly environmentNames: readonly string[];
      }
    | { readonly status: "unregistered"; readonly testId: TestId; readonly executorId: string };
  readonly deadlineAtMonotonicMs: number;
  readonly termination: "natural" | "abort" | "deadline" | "infrastructure";
  readonly identity: ProcessIdentityReceipt;
  readonly signals: readonly SignalAttemptReceipt[];
  readonly exit: ProcessExitReceipt;
  readonly stdio: StdioReceipt;
  readonly cleanup: ProcessCleanupReceipt;
}

export type CommandRunResult = RunResult & {
  readonly command: CommandExecutionReceipt;
};
