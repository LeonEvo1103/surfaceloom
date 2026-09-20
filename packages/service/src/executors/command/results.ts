import { randomUUID } from "node:crypto";

import type { ExecuteRequest } from "../../execution.js";
import { deepFreeze } from "../../safe-data.js";
import type {
  CommandExecutionReceipt, CommandRunResult, ProcessCleanupReceipt, ProcessExitReceipt,
  ProcessTreeReceipt, RegisteredCommand, SignalAttemptReceipt,
} from "./contracts.js";
import type { TerminationTrigger } from "./lifecycle.js";
import type { ProcessObserver } from "./process-observer.js";

export function finishForEvent(
  request: ExecuteRequest,
  command: RegisteredCommand,
  startedAt: string,
  deadlineAt: number,
  trigger: TerminationTrigger,
  detail: string | undefined,
  observer: ProcessObserver,
  signals: readonly SignalAttemptReceipt[],
  processTree: ProcessTreeReceipt,
  wallNow: () => Date,
): CommandRunResult {
  if (trigger === "natural" && observer.failureMessage !== null) {
    return finish(request, command, startedAt, deadlineAt, "infrastructure", observer, signals, processTree,
      "command_stream_failed", observer.failureMessage, wallNow);
  }
  if (trigger === "abort") {
    return finish(request, command, startedAt, deadlineAt, trigger, observer, signals, processTree,
      "command_cancelled", "Command execution was cancelled.", wallNow);
  }
  if (trigger === "deadline") {
    return finish(request, command, startedAt, deadlineAt, trigger, observer, signals, processTree,
      "deadline_exceeded", "Command exceeded its absolute deadline.", wallNow);
  }
  if (trigger === "infrastructure") {
    const code = observer.exitReceipt?.status === "not-spawned" ? "spawn_failed" : "command_stream_failed";
    return finish(request, command, startedAt, deadlineAt, trigger, observer, signals, processTree,
      code, detail ?? "Command process infrastructure failed.", wallNow);
  }
  const exit = observer.exitReceipt;
  if (exit?.status !== "exited") {
    return finish(request, command, startedAt, deadlineAt, "infrastructure", observer, signals, processTree,
      "process_exit_unconfirmed", "Command process exit was not confirmed.", wallNow);
  }
  if (exit.signal !== null || exit.code === null) {
    return finish(request, command, startedAt, deadlineAt, "infrastructure", observer, signals, processTree,
      "command_signalled", "Command exited without a classifiable exit code.", wallNow);
  }
  if (command.exitCodes.passed.includes(exit.code)) {
    return finish(request, command, startedAt, deadlineAt, trigger, observer, signals, processTree,
      "passed", "", wallNow);
  }
  if (command.exitCodes.failed.includes(exit.code)) {
    return finish(request, command, startedAt, deadlineAt, trigger, observer, signals, processTree,
      "business_failed", `Registered command reported product failure with exit code ${exit.code}.`, wallNow);
  }
  return finish(request, command, startedAt, deadlineAt, "infrastructure", observer, signals, processTree,
    "command_exit_unclassified", `Unclassified command exit code ${exit.code}.`, wallNow);
}

export function finishLaunchFailure(
  request: ExecuteRequest,
  command: RegisteredCommand,
  startedAt: string,
  deadlineAt: number,
  detail: string,
  observer: ProcessObserver,
  signals: readonly SignalAttemptReceipt[],
  processTree: ProcessTreeReceipt,
  wallNow: () => Date,
): CommandRunResult {
  return finish(request, command, startedAt, deadlineAt, "infrastructure", observer, signals,
    processTree, "spawn_failed", detail, wallNow);
}

export function noProcessResult(
  request: ExecuteRequest,
  command: RegisteredCommand | undefined,
  startedAt: string,
  wallNow: () => Date,
  deadlineAt: number,
  termination: TerminationTrigger,
  status: "failed" | "cancelled",
  code: string,
  message: string,
): CommandRunResult {
  const cleanup: ProcessCleanupReceipt = Object.freeze({ status: "not-required", tainted: false,
    processTree: Object.freeze({ status: "not-required" }) });
  const commandReceipt: CommandExecutionReceipt = Object.freeze({
    registration: command === undefined ? Object.freeze({
      status: "unregistered" as const, testId: request.testId,
      executorId: request.definition.runtime.executorId,
    }) : registration(command),
    deadlineAtMonotonicMs: deadlineAt,
    termination,
    identity: Object.freeze({ instanceId: randomUUID(), status: "not-spawned" as const, pid: null }),
    signals: Object.freeze([]),
    exit: Object.freeze({ status: "not-spawned" as const }),
    stdio: Object.freeze({ stdout: emptyOutput(), stderr: emptyOutput(), childCloseObserved: false }),
    cleanup,
  });
  return incompleteResult(request, startedAt, wallNow, commandReceipt, status, code, message);
}

function finish(
  request: ExecuteRequest, command: RegisteredCommand, startedAt: string, deadlineAt: number,
  termination: TerminationTrigger, observer: ProcessObserver,
  signals: readonly SignalAttemptReceipt[], processTree: ProcessTreeReceipt,
  classification: string, message: string,
  wallNow: () => Date,
): CommandRunResult {
  const cleanup = processCleanup(observer.exitReceipt, observer.stdioTerminal, processTree);
  const commandReceipt = receipt(command, deadlineAt, termination, observer, signals, cleanup);
  if (cleanup.status === "unconfirmed" &&
    (classification === "passed" || classification === "business_failed")) {
    return incompleteResult(request, startedAt, wallNow, commandReceipt, "failed",
      "cleanup_unconfirmed", "Command cleanup could not be confirmed.");
  }
  if (classification === "passed") {
    return deepFreeze({ ...resultBase(request, startedAt, wallNow, commandReceipt),
      executionStatus: "completed" as const, outcome: "passed" as const }) as CommandRunResult;
  }
  if (classification === "business_failed") {
    return deepFreeze({ ...resultBase(request, startedAt, wallNow, commandReceipt),
      executionStatus: "completed" as const, outcome: "failed" as const,
      reason: message }) as CommandRunResult;
  }
  const status = classification === "command_cancelled" ? "cancelled" : "failed";
  return incompleteResult(request, startedAt, wallNow, commandReceipt, status, classification, message);
}

function processCleanup(
  exit: ProcessExitReceipt | null, stdioTerminal: boolean, processTree: ProcessTreeReceipt,
): ProcessCleanupReceipt {
  if (exit?.status === "not-spawned") {
    return Object.freeze({ status: "not-required", tainted: false,
      processTree: Object.freeze({ status: "not-required" }) });
  }
  if (exit?.status === "exited" && stdioTerminal && processTree.status === "confirmed") {
    return Object.freeze({ status: "confirmed", tainted: false, processTree });
  }
  return Object.freeze({ status: "unconfirmed", tainted: true, processTree,
    detail: "Direct exit, stdio terminal, and owned process-tree cleanup were not all confirmed." });
}

function receipt(
  command: RegisteredCommand, deadlineAt: number, termination: TerminationTrigger,
  observer: ProcessObserver, signals: readonly SignalAttemptReceipt[], cleanup: ProcessCleanupReceipt,
): CommandExecutionReceipt {
  return Object.freeze({ registration: registration(command), deadlineAtMonotonicMs: deadlineAt,
    termination, identity: observer.identity(), signals,
    exit: observer.exitReceipt ?? Object.freeze({ status: "unconfirmed" as const,
      detail: "No process-exit receipt was produced." }),
    stdio: observer.stdioReceipt(), cleanup });
}

function registration(command: RegisteredCommand) {
  return Object.freeze({ status: "registered" as const, testId: command.testId,
    executorId: command.executorId, executable: command.executable, argv: command.argv,
    cwd: command.cwd, environmentNames: command.inheritEnvironment });
}

function emptyOutput() {
  return Object.freeze({ text: "", bytesSeen: 0, bytesRetained: 0, truncated: false, terminal: true });
}

function resultBase(
  request: ExecuteRequest, startedAt: string, wallNow: () => Date, command: CommandExecutionReceipt,
) {
  return { runId: request.runId,
    snapshot: Object.freeze({ snapshotId: request.snapshot.snapshotId,
      resolvedRevision: request.snapshot.resolvedRevision }),
    testId: request.testId, parameters: request.parameters,
    ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
    ...(request.executionLinks === undefined ? {} : { executionLinks: request.executionLinks }),
    startedAt, finishedAt: wallNow().toISOString(), artifacts: Object.freeze([]),
    cleanup: Object.freeze({ runId: request.runId, snapshotId: request.snapshot.snapshotId,
      status: command.cleanup.status, tainted: command.cleanup.tainted,
      attemptedAt: wallNow().toISOString(),
      ...(command.cleanup.detail === undefined ? {} : { detail: command.cleanup.detail }) }),
    command };
}

function incompleteResult(
  request: ExecuteRequest, startedAt: string, wallNow: () => Date,
  command: CommandExecutionReceipt, status: "failed" | "cancelled" | "interrupted",
  code: string, message: string,
): CommandRunResult {
  return deepFreeze({ ...resultBase(request, startedAt, wallNow, command), executionStatus: status,
    outcome: null, error: Object.freeze({ code, message, retryable: false }) }) as CommandRunResult;
}
