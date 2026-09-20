import assert from "node:assert/strict";
import test from "node:test";

import { CommandExecutor } from "../../../src/executors/command/index.js";
import { command, FakeChild, options, request, workspaceRoot } from "./helpers.js";

test("a surviving inherited-stdio descendant cannot yield passed or confirmed cleanup", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const grandchild = `setTimeout(() => {}, 5000)`;
  const parent = [
    `const {spawn}=require("node:child_process")`,
    `const child=spawn(process.execPath,["--eval",${JSON.stringify(grandchild)}],` +
      `{stdio:["ignore","inherit","inherit"]})`,
    `process.stdout.write(String(child.pid)+"\\n")`,
    `child.unref()`,
  ].join(";");
  const executor = new CommandExecutor("registered.node", options(command(["--eval", parent]), {
    processTree: undefined,
    stdioCloseWaitMs: 15,
    processTreeWaitMs: 15,
  }));
  const result = await executor.execute(request(root), new AbortController().signal);
  const pid = Number.parseInt(result.command.stdio.stdout.text.trim(), 10);
  t.after(() => {
    if (Number.isInteger(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Descendant may have exited naturally. */ }
    }
  });

  assert.equal(result.executionStatus, "failed");
  assert.equal(result.outcome, null);
  assert.equal(result.cleanup.status, "unconfirmed");
  assert.equal(result.cleanup.tainted, true);
  assert.equal(result.command.cleanup.processTree.status, "unconfirmed");
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.doesNotThrow(() => process.kill(pid, 0), "the counterexample descendant must still be alive");
});

test("a process-tree adapter that never returns ends bounded and tainted", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const executor = new CommandExecutor("registered.node", options(command(["--eval", "void 0"]), {
    processTreeWaitMs: 5,
    processTree: { launch: (spawn, executable, argv, spawnOptions) => ({
      child: spawn(executable, argv, spawnOptions),
      handle: { cleanup: async () => new Promise(() => {}) },
    }) },
  }));
  const started = Date.now();
  const result = await executor.execute(request(root), new AbortController().signal);

  assert.ok(Date.now() - started < 1_000);
  assert.equal(result.outcome, null);
  assert.equal(result.command.cleanup.processTree.status, "unconfirmed");
  assert.equal(result.command.cleanup.tainted, true);
});

test("an invalid cleanup receipt resolves once as a frozen unconfirmed result", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const child = new FakeChild();
  let cleanupCalls = 0;
  let cleanupStarted!: () => void;
  const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
  let finishCleanup!: () => void;
  const executor = new CommandExecutor("registered.node", options(command([]), {
    spawn: () => {
      queueMicrotask(() => {
        child.spawn();
        child.exit(0);
        child.closeStreams();
        child.close();
      });
      return child.asCommandChild();
    },
    processTreeWaitMs: 500,
    processTree: {
      launch: (spawn, executable, argv, spawnOptions) => ({
        child: spawn(executable, argv, spawnOptions),
        handle: {
          cleanup: async () => {
            cleanupCalls += 1;
            cleanupStarted();
            await new Promise<void>((resolve) => { finishCleanup = resolve; });
            return { status: "confirmed", unexpected: true } as never;
          },
        },
      }),
    },
  }));
  const input = request(root);
  const execution = executor.execute(input, new AbortController().signal);
  await started;
  const firstCleanup = executor.cleanup({ runId: input.runId, snapshot: input.workspace },
    new AbortController().signal);
  const replayCleanup = executor.cleanup({ runId: input.runId, snapshot: input.workspace },
    new AbortController().signal);
  finishCleanup();

  const [result, first, replay] = await Promise.all([execution, firstCleanup, replayCleanup]);

  assert.equal(cleanupCalls, 1);
  assert.equal(result.executionStatus, "failed");
  assert.equal(result.outcome, null);
  assert.equal(result.command.cleanup.status, "unconfirmed");
  assert.equal(result.command.cleanup.tainted, true);
  assert.equal(result.command.cleanup.processTree.status, "unconfirmed");
  assert.ok(Object.isFrozen(result.command.cleanup.processTree));
  assert.strictEqual(first, result.cleanup);
  assert.strictEqual(replay, result.cleanup);
});

test("a deferred spawn capability is closed when synchronous launch throws", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  let spawnCalls = 0;
  let lateError: unknown;
  let settleLate!: () => void;
  const late = new Promise<void>((resolve) => { settleLate = resolve; });
  const executor = new CommandExecutor("registered.node", options(command([]), {
    spawn: () => {
      spawnCalls += 1;
      return new FakeChild().asCommandChild();
    },
    processTree: {
      launch: (spawn, executable, argv, spawnOptions) => {
        setImmediate(() => {
          try { spawn(executable, argv, spawnOptions); } catch (error) { lateError = error; }
          settleLate();
        });
        throw new Error("launch failed before spawn");
      },
    },
  }));

  const result = await executor.execute(request(root), new AbortController().signal);
  await late;

  assert.equal(spawnCalls, 0);
  assert.match(String(lateError), /capability expired/u);
  assert.equal(result.executionStatus, "failed");
  assert.equal(result.command.identity.status, "not-spawned");
  assert.equal(result.command.cleanup.status, "not-required");
  assert.equal(result.command.cleanup.tainted, false);
});

test("a successful launch cannot reuse its spawn capability after returning", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const child = new FakeChild();
  let spawnCalls = 0;
  let lateError: unknown;
  let settleLate!: () => void;
  const late = new Promise<void>((resolve) => { settleLate = resolve; });
  const executor = new CommandExecutor("registered.node", options(command([]), {
    spawn: () => {
      spawnCalls += 1;
      queueMicrotask(() => {
        child.spawn(); child.exit(0); child.closeStreams(); child.close();
      });
      return child.asCommandChild();
    },
    processTree: {
      launch: (spawn, executable, argv, spawnOptions) => {
        const launched = spawn(executable, argv, spawnOptions);
        setImmediate(() => {
          try { spawn(executable, argv, spawnOptions); } catch (error) { lateError = error; }
          settleLate();
        });
        return { child: launched,
          handle: { cleanup: async () => ({ status: "confirmed" as const }) } };
      },
    },
  }));

  const result = await executor.execute(request(root), new AbortController().signal);
  await late;

  assert.equal(spawnCalls, 1);
  assert.match(String(lateError), /capability expired/u);
  assert.equal(result.executionStatus, "completed");
  assert.equal(result.outcome, "passed");
  assert.equal(result.command.cleanup.status, "confirmed");
});

test("an asynchronous process-tree launch is rejected before its deferred spawn", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  let spawnCalls = 0;
  let lateError: unknown;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown): void => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  let settleLate!: () => void;
  const late = new Promise<void>((resolve) => { settleLate = resolve; });
  const asynchronousLaunch = async (
    spawn: Parameters<NonNullable<ReturnType<typeof options>["processTree"]>["launch"]>[0],
    executable: string,
    argv: readonly string[],
    spawnOptions: Parameters<typeof spawn>[2],
  ): Promise<never> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      spawn(executable, argv, spawnOptions);
    } catch (error) {
      lateError = error;
      throw error;
    } finally {
      settleLate();
    }
  };
  const executor = new CommandExecutor("registered.node", options(command([]), {
    spawn: () => {
      spawnCalls += 1;
      return new FakeChild().asCommandChild();
    },
    processTree: { launch: asynchronousLaunch as never },
  }));

  const result = await executor.execute(request(root), new AbortController().signal);
  await late;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(spawnCalls, 0);
  assert.match(String(lateError), /capability expired/u);
  assert.deepEqual(unhandled, []);
  assert.equal(result.executionStatus, "failed");
  if (result.executionStatus !== "completed") assert.equal(result.error.code, "spawn_failed");
  assert.equal(result.command.identity.status, "not-spawned");
  assert.equal(result.command.cleanup.status, "not-required");
});

test("unknown thenables are rejected without reading or invoking their then property", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  let spawnCalls = 0;
  let thenReads = 0;
  const executor = new CommandExecutor("registered.node", options(command([]), {
    spawn: () => {
      spawnCalls += 1;
      return new FakeChild().asCommandChild();
    },
    processTree: {
      launch: (() => Object.create(null, {
        then: { enumerable: true, get() { thenReads += 1; throw new Error("must not read then"); } },
      })) as never,
    },
  }));

  const result = await executor.execute(request(root), new AbortController().signal);

  assert.equal(spawnCalls, 0);
  assert.equal(thenReads, 0);
  assert.equal(result.executionStatus, "failed");
  if (result.executionStatus !== "completed") assert.equal(result.error.code, "spawn_failed");
  assert.equal(result.command.cleanup.status, "not-required");
});
