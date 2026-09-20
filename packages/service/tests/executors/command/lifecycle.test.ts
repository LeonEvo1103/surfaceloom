import assert from "node:assert/strict";
import test from "node:test";

import { CommandExecutor } from "../../../src/executors/command/index.js";
import { command, FakeChild, options, request, workspaceRoot } from "./helpers.js";

test("spawn throw is infrastructure failure with a not-spawned receipt", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const executor = new CommandExecutor("registered.node", options(command([]), {
    spawn: () => { throw new Error("spawn exploded"); },
  }));
  const result = await executor.execute(request(root), new AbortController().signal);

  assert.equal(result.executionStatus, "failed");
  assert.equal(result.outcome, null);
  if (result.executionStatus !== "completed") assert.equal(result.error.code, "spawn_failed");
  assert.equal(result.command.identity.status, "not-spawned");
  assert.deepEqual(result.command.exit, { status: "not-spawned" });
  assert.equal(result.cleanup.status, "not-required");
});

test("a controller throw after a real spawn terminates the registered child and stays tainted", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  let pid: number | undefined;
  t.after(() => {
    if (pid !== undefined) {
      try { process.kill(pid, "SIGKILL"); } catch { /* The executor should already have reaped it. */ }
    }
  });
  const executor = new CommandExecutor("registered.node", options(
    command(["--eval", "setInterval(() => {}, 1000)"]), {
      processTree: {
        launch: (spawn, executable, argv, spawnOptions) => {
          const child = spawn(executable, argv, spawnOptions);
          pid = child.pid;
          throw new Error("containment assignment failed");
        },
      },
    },
  ));

  const result = await executor.execute(request(root), new AbortController().signal);

  assert.equal(result.executionStatus, "failed");
  assert.equal(result.outcome, null);
  if (result.executionStatus !== "completed") assert.equal(result.error.code, "spawn_failed");
  assert.notEqual(result.command.identity.status, "not-spawned");
  assert.equal(result.command.identity.pid, pid);
  assert.notDeepEqual(result.command.exit, { status: "not-spawned" });
  assert.ok(result.command.signals.length > 0);
  assert.equal(result.command.cleanup.status, "unconfirmed");
  assert.equal(result.command.cleanup.tainted, true);
  assert.equal(result.command.cleanup.processTree.status, "unconfirmed");
  assert.ok(pid !== undefined);
  assert.throws(() => process.kill(pid, 0), /ESRCH/u);
});

test("an invalid process-tree handle after spawn still terminates the child", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const child = new FakeChild();
  child.killBehavior = (signal) => {
    queueMicrotask(() => {
      child.exit(null, signal);
      child.closeStreams();
      child.close();
    });
    return true;
  };
  const executor = new CommandExecutor("registered.node", options(command([]), {
    spawn: () => {
      queueMicrotask(() => child.spawn());
      return child.asCommandChild();
    },
    processTree: {
      launch: (spawn, executable, argv, spawnOptions) => ({
        child: spawn(executable, argv, spawnOptions),
        handle: {} as never,
      }),
    },
  }));

  const result = await executor.execute(request(root), new AbortController().signal);

  assert.equal(result.executionStatus, "failed");
  assert.equal(result.outcome, null);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(result.command.identity.status, "spawn-observed");
  assert.equal(result.command.cleanup.status, "unconfirmed");
  assert.equal(result.command.cleanup.tainted, true);
  assert.equal(result.command.cleanup.processTree.status, "unconfirmed");
});

test("abort before spawn performs no spawn and abort after spawn owns termination", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  let spawnCalls = 0;
  const before = new AbortController();
  before.abort("cancel first");
  const skipped = new CommandExecutor("registered.node", options(command([]), {
    spawn: () => { spawnCalls += 1; return new FakeChild().asCommandChild(); },
  }));
  const beforeResult = await skipped.execute(request(root), before.signal);
  assert.equal(spawnCalls, 0);
  assert.equal(beforeResult.executionStatus, "cancelled");
  assert.equal(beforeResult.command.cleanup.status, "not-required");

  const child = new FakeChild();
  child.killBehavior = (signal) => {
    queueMicrotask(() => {
      child.exit(null, signal);
      child.closeStreams();
      child.close();
    });
    return true;
  };
  const after = new AbortController();
  let spawned!: () => void;
  const spawnCalled = new Promise<void>((resolve) => { spawned = resolve; });
  const running = new CommandExecutor("registered.node", options(command([]), {
    spawn: () => { spawned(); queueMicrotask(() => child.spawn()); return child.asCommandChild(); },
  }));
  const promise = running.execute(request(root), after.signal);
  await spawnCalled;
  after.abort("cancel after spawn");
  const afterResult = await promise;
  assert.equal(afterResult.executionStatus, "cancelled");
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(afterResult.command.exit.status, "exited");
  assert.equal(afterResult.command.cleanup.status, "confirmed");
});

test("absolute deadline wins when exit arrives in the same tick before timer delivery", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const child = new FakeChild();
  const times = [0, 0, 10, 10];
  const executor = new CommandExecutor("registered.node", options(command([], { timeoutMs: 10 }), {
    monotonicNow: () => times.shift() ?? 10,
    spawn: () => {
      queueMicrotask(() => {
        child.spawn();
        child.exit(0);
        child.closeStreams();
        child.close();
      });
      return child.asCommandChild();
    },
  }));
  const result = await executor.execute(request(root), new AbortController().signal);

  assert.equal(result.executionStatus, "failed");
  assert.equal(result.outcome, null);
  assert.equal(result.command.termination, "deadline");
  if (result.executionStatus !== "completed") assert.equal(result.error.code, "deadline_exceeded");
});

test("process exit and stdio terminal receipts may arrive in either order", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  for (const order of ["exit-first", "stdio-first"] as const) {
    const child = new FakeChild();
    const executor = new CommandExecutor("registered.node", options(command([]), {
      spawn: () => {
        queueMicrotask(() => {
          child.spawn();
          if (order === "exit-first") {
            child.exit(0);
            setTimeout(() => { child.closeStreams(); child.close(); }, 2);
          } else {
            child.closeStreams();
            setTimeout(() => { child.exit(0); child.close(); }, 2);
          }
        });
        return child.asCommandChild();
      },
    }));
    const result = await executor.execute(request(root), new AbortController().signal);
    assert.equal(result.outcome, "passed", order);
    assert.equal(result.command.exit.status, "exited", order);
    assert.equal(result.command.stdio.stdout.terminal, true, order);
    assert.equal(result.command.stdio.stderr.terminal, true, order);
    assert.equal(result.command.cleanup.status, "confirmed", order);
  }
});

test("tree cleanup and asynchronous stdio EOF may finish in either order without losing tail output", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  for (const order of ["tree-first", "stdio-first"] as const) {
    const child = new FakeChild();
    const closeWithTail = (): void => {
      child.stdout.write(`stdout-${order}`);
      child.stderr.write(`stderr-${order}`);
      child.closeStreams();
      child.close();
    };
    const executor = new CommandExecutor("registered.node", options(command([]), {
      stdioCloseWaitMs: 50,
      spawn: () => {
        queueMicrotask(() => { child.spawn(); child.exit(0); });
        return child.asCommandChild();
      },
      processTree: {
        launch: (spawn, executable, argv, spawnOptions) => ({
          child: spawn(executable, argv, spawnOptions),
          handle: {
            cleanup: async () => {
              if (order === "tree-first") setImmediate(closeWithTail);
              else await new Promise<void>((resolve) => setImmediate(() => {
                closeWithTail();
                resolve();
              }));
              return { status: "confirmed" as const };
            },
          },
        }),
      },
    }));

    const result = await executor.execute(request(root), new AbortController().signal);

    assert.equal(result.executionStatus, "completed", order);
    assert.equal(result.outcome, "passed", order);
    assert.equal(result.command.stdio.stdout.text, `stdout-${order}`, order);
    assert.equal(result.command.stdio.stderr.text, `stderr-${order}`, order);
    assert.equal(result.command.stdio.stdout.terminal, true, order);
    assert.equal(result.command.stdio.stderr.terminal, true, order);
    assert.equal(result.command.cleanup.processTree.status, "confirmed", order);
    assert.equal(result.command.cleanup.status, "confirmed", order);
  }
});

test("confirmed tree cleanup with streams that never close stays bounded and tainted", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const child = new FakeChild();
  const executor = new CommandExecutor("registered.node", options(command([]), {
    stdioCloseWaitMs: 5,
    spawn: () => {
      queueMicrotask(() => { child.spawn(); child.exit(0); });
      return child.asCommandChild();
    },
  }));
  const started = Date.now();

  const result = await executor.execute(request(root), new AbortController().signal);

  assert.ok(Date.now() - started < 1_000);
  assert.equal(result.executionStatus, "failed");
  assert.equal(result.outcome, null);
  if (result.executionStatus !== "completed") assert.equal(result.error.code, "cleanup_unconfirmed");
  assert.equal(result.command.exit.status, "exited");
  assert.equal(result.command.cleanup.processTree.status, "confirmed");
  assert.equal(result.command.stdio.stdout.terminal, false);
  assert.equal(result.command.stdio.stderr.terminal, false);
  assert.equal(result.command.cleanup.status, "unconfirmed");
  assert.equal(result.command.cleanup.tainted, true);
  assert.equal(child.unrefCalls, 1);
});

test("cleanup-driven stdio closure cannot turn deadline or cancellation into success", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  for (const trigger of ["deadline", "cancel"] as const) {
    const child = new FakeChild();
    let logicalNow = 0;
    child.killBehavior = (signal) => {
      queueMicrotask(() => child.exit(null, signal));
      return true;
    };
    let spawned!: () => void;
    const spawnCalled = new Promise<void>((resolve) => { spawned = resolve; });
    const executor = new CommandExecutor("registered.node", options(
      command([], { timeoutMs: trigger === "deadline" ? 1 : 5_000 }), {
        ...(trigger === "deadline" ? { monotonicNow: () => logicalNow } : {}),
        stdioCloseWaitMs: 50,
        spawn: () => {
          if (trigger === "deadline") logicalNow = 1;
          spawned();
          queueMicrotask(() => child.spawn());
          return child.asCommandChild();
        },
        processTree: {
          launch: (spawn, executable, argv, spawnOptions) => ({
            child: spawn(executable, argv, spawnOptions),
            handle: { cleanup: async () => {
              setImmediate(() => {
                child.stdout.write(`tail-${trigger}`);
                child.closeStreams();
                child.close();
              });
              return { status: "confirmed" as const };
            } },
          }),
        },
      },
    ));
    const abort = new AbortController();
    const execution = executor.execute(request(root), abort.signal);
    await spawnCalled;
    if (trigger === "cancel") abort.abort("cancel regression");

    const result = await execution;

    assert.equal(result.outcome, null, trigger);
    assert.equal(result.executionStatus, trigger === "cancel" ? "cancelled" : "failed", trigger);
    if (result.executionStatus !== "completed") {
      assert.equal(result.error.code,
        trigger === "cancel" ? "command_cancelled" : "deadline_exceeded", trigger);
    }
    assert.equal(result.command.stdio.stdout.text, `tail-${trigger}`, trigger);
    assert.equal(result.command.cleanup.status, "confirmed", trigger);
  }
});

test("signal failures and a process that never exits end bounded as unconfirmed and tainted", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const child = new FakeChild();
  let attempts = 0;
  child.killBehavior = () => {
    attempts += 1;
    if (attempts === 1) throw new Error("signal denied");
    return false;
  };
  let signalSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => { signalSpawned = resolve; });
  const executor = new CommandExecutor("registered.node", options(command([], { timeoutMs: 5_000 }), {
    terminateGraceMs: 2,
    forceKillWaitMs: 2,
    stdioCloseWaitMs: 2,
    spawn: () => {
      queueMicrotask(() => { child.spawn(); signalSpawned(); });
      return child.asCommandChild();
    },
  }));
  const stop = new AbortController();
  const started = Date.now();
  const execution = executor.execute(request(root), stop.signal);
  await spawned;
  stop.abort(new Error("cancel non-terminating process"));
  const result = await execution;

  assert.ok(Date.now() - started < 1_000);
  assert.equal(result.executionStatus, "cancelled");
  assert.equal(result.outcome, null);
  assert.equal(result.command.exit.status, "unconfirmed");
  assert.deepEqual(result.command.signals.map((item) => item.outcome), ["threw", "rejected"]);
  assert.equal(result.command.cleanup.status, "unconfirmed");
  assert.equal(result.cleanup.tainted, true);
  assert.equal(child.unrefCalls, 1);
});

test("duplicate delivery of the same runId returns one execution promise and never respawns", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const child = new FakeChild();
  let spawnCalls = 0;
  const executor = new CommandExecutor("registered.node", options(command([]), {
    spawn: () => {
      spawnCalls += 1;
      queueMicrotask(() => {
        child.spawn(); child.exit(0); child.closeStreams(); child.close();
      });
      return child.asCommandChild();
    },
  }));
  const sameRequest = request(root);
  const first = executor.execute(sameRequest, new AbortController().signal);
  const replay = executor.execute(sameRequest, new AbortController().signal);

  assert.strictEqual(first, replay);
  assert.strictEqual(await first, await replay);
  assert.equal(spawnCalls, 1);
});
