import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createOperationId } from "../../src/ids.js";
import type { PrepareWorkspaceRequest } from "../../src/workspace.js";

const execute = promisify(execFile);

export interface GitFixture {
  readonly root: string;
  readonly sourceRoot: string;
  readonly repository: string;
  readonly snapshotRoot: string;
  readonly revision: string;
  readonly request: (revision?: string) => PrepareWorkspaceRequest;
  readonly git: (...args: readonly string[]) => Promise<string>;
  readonly dispose: () => Promise<void>;
}

export async function createGitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-workspace-"));
  const sourceRoot = path.join(root, "sources");
  const repository = path.join(sourceRoot, "fixture-repo");
  const snapshotRoot = path.join(root, "snapshots");
  await mkdir(repository, { recursive: true });

  const git = async (...args: readonly string[]): Promise<string> => {
    const result = await execute("git", [...args], {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return result.stdout;
  };
  await git("init", "--quiet");
  await git("config", "user.email", "workspace@example.invalid");
  await git("config", "user.name", "Workspace Fixture");
  await writeFile(path.join(repository, "committed.txt"), "committed\n", "utf8");
  await writeFile(path.join(repository, "executable.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  if (process.platform !== "win32") await chmod(path.join(repository, "executable.sh"), 0o755);
  await git("add", "--", "committed.txt", "executable.sh");
  await git("update-index", "--chmod=+x", "--", "executable.sh");
  await git("commit", "--quiet", "-m", "fixture");
  const revision = (await git("rev-parse", "HEAD")).trim();

  return {
    root,
    sourceRoot,
    repository,
    snapshotRoot,
    revision,
    request(requestedRevision = revision) {
      return {
        operationId: createOperationId(),
        source: { provider: "local-git", locator: "fixture-repo" },
        revision: requestedRevision,
      };
    },
    git,
    dispose: async () => {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function makeWritable(target: string): Promise<void> {
  let descriptor;
  try {
    descriptor = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (descriptor.isSymbolicLink()) return;
  await chmod(target, descriptor.isDirectory() ? 0o700 : 0o600);
  if (!descriptor.isDirectory()) return;
  for (const entry of await readdir(target)) await makeWritable(path.join(target, entry));
}
