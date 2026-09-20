import { spawn } from "node:child_process";

import type {
  WorkspaceCommandInvocation,
  WorkspaceCommandResult,
  WorkspaceCommandRunner,
} from "./contracts.js";

const maxOutputBytes = 64 * 1024;

export const runWorkspaceCommand: WorkspaceCommandRunner = async (
  invocation,
): Promise<WorkspaceCommandResult> => new Promise((resolve, reject) => {
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let settled = false;
  let overflowed = false;
  const child = spawn(invocation.file, [...invocation.args], {
    cwd: invocation.cwd,
    signal: invocation.signal,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const append = (
    current: Buffer<ArrayBufferLike>,
    chunk: Buffer<ArrayBufferLike>,
  ): Buffer<ArrayBufferLike> => {
    if (current.length + chunk.length > maxOutputBytes) {
      overflowed = true;
      child.kill();
      return current;
    }
    return Buffer.concat([current, chunk]);
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    reject(error);
  });
  child.once("close", (code) => {
    if (settled) return;
    settled = true;
    if (overflowed) {
      reject(new Error("Workspace command exceeded the bounded output limit."));
      return;
    }
    resolve({
      exitCode: code ?? -1,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
    });
  });
});

export async function runGit(
  runner: WorkspaceCommandRunner,
  gitBinary: string,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<WorkspaceCommandResult> {
  return runner({ file: gitBinary, args, cwd, signal, shell: false });
}
