import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import type { CleanupRequest, ExecuteRequest } from "../../execution.js";
import type { CleanupReceipt } from "../../workspace.js";
import type { CommandSpawn, RegisteredCommand } from "./contracts.js";

export const defaultSpawn: CommandSpawn = (executable, argv, options) => spawn(executable, [...argv], {
  cwd: options.cwd,
  env: { ...options.env },
  shell: false,
  detached: false,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

export async function resolveRegisteredCwd(rootPath: string, relative: string): Promise<string> {
  const root = await realpath(rootPath);
  const candidate = await realpath(path.resolve(root, relative));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Registered cwd resolves outside the workspace root.");
  }
  return candidate;
}

export function selectEnvironment(
  command: RegisteredCommand,
  request: ExecuteRequest,
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  for (const required of request.definition.requirements.environment) {
    if (!command.inheritEnvironment.includes(required)) {
      throw new Error(`Required environment name is not registered: ${required}`);
    }
    if (source[required] === undefined) {
      throw new Error(`Required environment value is missing: ${required}`);
    }
  }
  const result: Record<string, string> = {};
  for (const name of command.inheritEnvironment) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return Object.freeze(result);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown command infrastructure error.";
}

export function notRequiredCleanup(request: CleanupRequest, wallNow: () => Date): CleanupReceipt {
  return { runId: request.runId, snapshotId: request.snapshot.snapshotId, status: "not-required",
    tainted: false, attemptedAt: wallNow().toISOString() };
}

export function identityMismatchCleanup(request: CleanupRequest, wallNow: () => Date): CleanupReceipt {
  return { runId: request.runId, snapshotId: request.snapshot.snapshotId, status: "unconfirmed",
    tainted: true, attemptedAt: wallNow().toISOString(),
    detail: "Cleanup request workspace identity does not match the recorded execution." };
}
