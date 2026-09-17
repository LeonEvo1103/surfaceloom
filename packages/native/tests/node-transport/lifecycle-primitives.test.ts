import assert from "node:assert/strict";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { shutdownOwnedChild } from "../../src/node-transport/lifecycle.js";

test("kill failure reaches the force deadline and permits a later close observation", async () => {
  let stdinEnded = 0;
  let killCalls = 0;
  let lateClose!: () => void;
  const closed = new Promise<void>((resolve) => { lateClose = resolve; });
  const fake = {
    stdin: { destroyed: false, writableEnded: false, end: () => { stdinEnded += 1; } },
    stdout: {}, stderr: {},
    kill: () => { killCalls += 1; throw new Error("synthetic kill failure"); },
  } as unknown as ChildProcessWithoutNullStreams;
  let observedClosed = false;
  void closed.then(() => { observedClosed = true; });
  const confirmed = await shutdownOwnedChild(fake, closed, () => observedClosed, 0, 0);
  assert.equal(confirmed, false);
  assert.equal(stdinEnded, 1);
  assert.equal(killCalls, 1);
  lateClose();
  await closed;
  assert.equal(observedClosed, true);
});
