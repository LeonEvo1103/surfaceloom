import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import test from "node:test";

import { CommandExecutor } from "../../../src/executors/command/index.js";
import { command, options, request, workspaceRoot } from "./helpers.js";

test("runs exact registered argv, including repeats and empty values, with shell disabled", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const marker = "$HOME;echo should-not-run";
  const script = `process.stdout.write(JSON.stringify({argv:process.argv.slice(1),env:process.env}))`;
  const registeredArgv = ["--eval", script, marker, "", marker];
  const registered = command(registeredArgv, { inheritEnvironment: ["SAFE_VALUE"] });
  let observedOptions: unknown;
  const executor = new CommandExecutor("registered.node", options(registered, {
    allowedEnvironment: ["SAFE_VALUE"],
    environment: { SAFE_VALUE: "allowed", SECRET_VALUE: "blocked" },
    spawn: (file, argv, spawnOptions) => {
      observedOptions = spawnOptions;
      return spawn(file, [...argv], {
        cwd: spawnOptions.cwd, env: { ...spawnOptions.env }, shell: false, detached: false,
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
    },
  }));
  const result = await executor.execute(request(root), new AbortController().signal);

  assert.equal(result.executionStatus, "completed");
  assert.equal(result.outcome, "passed");
  const payload = JSON.parse(result.command.stdio.stdout.text) as {
    argv: string[]; env: Record<string, string>;
  };
  assert.deepEqual(payload.argv, [marker, "", marker]);
  assert.equal(payload.env.SAFE_VALUE, "allowed");
  assert.equal(payload.env.SECRET_VALUE, undefined);
  assert.equal(result.command.registration.status, "registered");
  assert.deepEqual(result.command.registration.argv, registeredArgv);
  assert.deepEqual(observedOptions, {
    cwd: await realpath(root), env: { SAFE_VALUE: "allowed" }, shell: false, detached: false,
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
});

test("stdout and stderr floods stay bounded and report explicit truncation", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const script = `process.stdout.write("o".repeat(200000));process.stderr.write("e".repeat(180000))`;
  const executor = new CommandExecutor("registered.node", options(command(["--eval", script]), {
    maxStdoutBytes: 127,
    maxStderrBytes: 61,
  }));
  const result = await executor.execute(request(root), new AbortController().signal);

  assert.equal(result.outcome, "passed");
  assert.equal(result.command.stdio.stdout.bytesSeen, 200_000);
  assert.equal(result.command.stdio.stdout.bytesRetained, 127);
  assert.equal(result.command.stdio.stdout.truncated, true);
  assert.equal(Buffer.byteLength(result.command.stdio.stdout.text), 127);
  assert.equal(result.command.stdio.stderr.bytesSeen, 180_000);
  assert.equal(result.command.stdio.stderr.bytesRetained, 61);
  assert.equal(result.command.stdio.stderr.truncated, true);
});

test("only explicitly classified exit codes become product outcomes", async (t) => {
  const root = await workspaceRoot((cleanup) => t.after(cleanup));
  const failed = new CommandExecutor("registered.node", options(command(["--eval", "process.exit(1)"])));
  const business = await failed.execute(request(root), new AbortController().signal);
  assert.equal(business.executionStatus, "completed");
  assert.equal(business.outcome, "failed");

  const unknown = new CommandExecutor("registered.node", options(command(["--eval", "process.exit(7)"])));
  const infrastructure = await unknown.execute(request(root), new AbortController().signal);
  assert.equal(infrastructure.executionStatus, "failed");
  assert.equal(infrastructure.outcome, null);
  if (infrastructure.executionStatus !== "completed") {
    assert.equal(infrastructure.error.code, "command_exit_unclassified");
  }
});

test("constructor rejects cwd and environment values outside exact allowlists", () => {
  assert.throws(() => new CommandExecutor("registered.node", options(command([], { cwd: "nested" }))),
    /cwd is not allowlisted/u);
  assert.throws(() => new CommandExecutor("registered.node", options(command([], {
    inheritEnvironment: ["SECRET"],
  }))), /Environment name is not allowlisted/u);
  assert.throws(() => new CommandExecutor("registered.node", options(command([], {
    cwd: "../escape",
  }), { allowedCwds: ["../escape"] })), /stay inside/u);
});
