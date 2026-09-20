import assert from "node:assert/strict";
import test from "node:test";

import { CommandExecutor } from "../../../src/executors/command/index.js";
import { command, FakeChild, options, request, workspaceRoot } from "./helpers.js";

test("registered executable accessors are rejected without a single read", () => {
  let calls = 0;
  const hostile = command([]) as unknown as Record<string, unknown>;
  Object.defineProperty(hostile, "executable", {
    enumerable: true,
    get() {
      calls += 1;
      return calls < 3 ? process.execPath : "relative-after-validation";
    },
  });
  assert.throws(() => new CommandExecutor("registered.node", options(hostile as never)), /accessors/u);
  assert.equal(calls, 0);
});

test("configuration rejects root and nested Proxies without invoking traps", () => {
  let calls = 0;
  const handler: ProxyHandler<object> = {
    get() { calls += 1; return undefined; },
    ownKeys() { calls += 1; return []; },
    getOwnPropertyDescriptor() { calls += 1; return undefined; },
    getPrototypeOf() { calls += 1; return Object.prototype; },
  };
  const root = new Proxy(options(command([])) as object, handler);
  assert.throws(() => new CommandExecutor("registered.node", root as never), /Proxy/u);
  assert.equal(calls, 0);

  const nested = command([]) as { argv: readonly string[] };
  nested.argv = new Proxy([] as string[], handler);
  assert.throws(() => new CommandExecutor("registered.node", options(nested as never)), /Proxy/u);
  assert.equal(calls, 0);

  const proxiedCommands = options(command([])) as { commands: readonly object[] };
  proxiedCommands.commands = new Proxy([...proxiedCommands.commands], handler);
  assert.throws(() => new CommandExecutor("registered.node", proxiedCommands as never), /Proxy/u);
  assert.equal(calls, 0);

  const hostileEnvironment = options(command([]), {
    environment: new Proxy({ SAFE: "value" }, handler) as never,
  });
  assert.throws(() => new CommandExecutor("registered.node", hostileEnvironment), /Proxy/u);
  const hostileExits = command([]) as unknown as { exitCodes: object };
  hostileExits.exitCodes = new Proxy({ passed: [0], failed: [1] }, handler);
  assert.throws(() => new CommandExecutor("registered.node", options(hostileExits as never)), /Proxy/u);
  assert.equal(calls, 0);
});

test("configuration rejects sparse arrays and shared mutable containers", () => {
  const sparse = command([]) as { argv: readonly string[] };
  sparse.argv = new Array<string>(1);
  assert.throws(() => new CommandExecutor("registered.node", options(sparse as never)), /dense/u);
  const sparseCommands = options(command([])) as { commands: readonly object[] };
  sparseCommands.commands = new Array<object>(1);
  assert.throws(() => new CommandExecutor("registered.node", sparseCommands as never), /dense/u);

  const shared: string[] = [];
  const aliased = command([]) as { argv: string[]; inheritEnvironment: string[] };
  aliased.argv = shared;
  aliased.inheritEnvironment = shared;
  assert.throws(() => new CommandExecutor("registered.node", options(aliased as never)), /reuses/u);
});

test("argv rejects accessors, invalid values, and over-budget arrays without losing repeat support", () => {
  let getterCalls = 0;
  const accessor = command(["safe"]) as { argv: string[] };
  Object.defineProperty(accessor.argv, "0", {
    enumerable: true,
    configurable: true,
    get() { getterCalls += 1; return "unsafe"; },
  });
  assert.throws(() => new CommandExecutor("registered.node", options(accessor as never)), /data property/u);
  assert.equal(getterCalls, 0);

  assert.throws(() => new CommandExecutor("registered.node", options(command(["ok", "bad\0arg"]))),
    /without NUL/u);
  assert.throws(() => new CommandExecutor("registered.node", options(command(["ok", 1 as never]))),
    /must be a string/u);
  assert.throws(() => new CommandExecutor("registered.node", options(command(
    Array.from({ length: 1_025 }, () => "repeat"),
  ))), /item budget/u);

  assert.doesNotThrow(() => new CommandExecutor(
    "registered.node", options(command(["repeat", "", "repeat"])),
  ));
});

test("argv and environment are immutable snapshots despite caller mutation", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const argv = ["--eval", "void 0"];
  const environment = { SAFE_VALUE: "original" };
  const registered = command(argv, { inheritEnvironment: ["SAFE_VALUE"] });
  const child = new FakeChild();
  let observedArgv: readonly string[] = [];
  let observedEnvironment: Readonly<Record<string, string>> = {};
  const executor = new CommandExecutor("registered.node", options(registered, {
    allowedEnvironment: ["SAFE_VALUE"], environment,
    spawn: (_file, actualArgv, spawnOptions) => {
      observedArgv = actualArgv;
      observedEnvironment = spawnOptions.env;
      queueMicrotask(() => { child.spawn(); child.exit(0); child.closeStreams(); child.close(); });
      return child.asCommandChild();
    },
  }));
  argv[1] = "process.exit(99)";
  environment.SAFE_VALUE = "polluted";
  const result = await executor.execute(request(root), new AbortController().signal);

  assert.equal(result.outcome, "passed");
  assert.deepEqual(observedArgv, ["--eval", "void 0"]);
  assert.deepEqual(observedEnvironment, { SAFE_VALUE: "original" });
});
