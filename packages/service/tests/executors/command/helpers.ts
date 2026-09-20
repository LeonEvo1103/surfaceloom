import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import type { ExecuteRequest } from "../../../src/execution.js";
import type {
  CommandChild, CommandExecutorOptions, RegisteredCommand,
} from "../../../src/executors/command/index.js";
import { createOperationId, createRunId, parseTestId } from "../../../src/ids.js";
import { validateTestDefinition } from "../../../src/validate-definition.js";
import { validDefinition } from "../../fixtures.js";

export const testId = parseTestId("service-test:reference/smoke");

export async function workspaceRoot(after: (callback: () => Promise<void>) => void): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-command-"));
  after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export function command(argv: readonly string[], overrides: Partial<RegisteredCommand> = {}): RegisteredCommand {
  return {
    testId,
    executorId: "registered.node",
    executable: process.execPath,
    argv,
    cwd: ".",
    inheritEnvironment: [],
    timeoutMs: 5_000,
    exitCodes: { passed: [0], failed: [1] },
    ...overrides,
  };
}

export function options(
  registered: RegisteredCommand,
  overrides: Partial<CommandExecutorOptions> = {},
): CommandExecutorOptions {
  return {
    commands: [registered],
    allowedCwds: ["."],
    allowedEnvironment: [],
    terminateGraceMs: 10,
    forceKillWaitMs: 20,
    stdioCloseWaitMs: 20,
    processTreeWaitMs: 20,
    processTree: {
      launch: (spawn, executable, argv, spawnOptions) => ({
        child: spawn(executable, argv, spawnOptions),
        handle: { cleanup: async () => ({ status: "confirmed" as const }) },
      }),
    },
    ...overrides,
  };
}

export function request(rootPath: string, overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
  const raw = validDefinition();
  raw.output = { resultFormat: "surfaceloom.run-result/v1", artifacts: [] };
  const definition = validateTestDefinition(raw);
  return {
    runId: createRunId(),
    snapshot: { snapshotId: "snapshot-command", resolvedRevision: "abc123" },
    testId,
    parameters: {},
    definition,
    workspace: {
      operationId: createOperationId(),
      snapshotId: "snapshot-command",
      resolvedRevision: "abc123",
      rootPath,
      runtimeMetadata: {},
      autMetadata: {},
    },
    ...overrides,
  };
}

export class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 43210;
  kills: NodeJS.Signals[] = [];
  unrefCalls = 0;
  killBehavior: (signal: NodeJS.Signals) => boolean = () => true;

  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return this.killBehavior(signal);
  }

  unref(): void { this.unrefCalls += 1; }
  asCommandChild(): CommandChild { return this as unknown as CommandChild; }

  spawn(): void { this.emit("spawn"); }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
  close(): void { this.emit("close", null, null); }
  closeStreams(): void { this.stdout.end(); this.stderr.end(); }
}
