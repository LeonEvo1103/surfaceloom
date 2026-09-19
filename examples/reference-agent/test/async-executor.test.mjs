import assert from "node:assert/strict";
import test from "node:test";

import {
  createRunEngine,
  inspectToolCalls,
  LedgerIncompleteError,
  startReferenceAgent,
} from "../src/index.mjs";

test("stop at before-submit proves notExecuted and resume cannot clear cancellation", async () => {
  const engine = createRunEngine();
  const run = engine.createRun();
  engine.pauseCheckpoint(run.runId, "before-submit");
  assert.equal(engine.decide(run.runId, "approve").status, "executing");

  const stopped = engine.stop(run.runId, { mode: "stop" });
  assert.equal(stopped.outcome, "notExecuted");
  assert.equal(stopped.submitted, false);
  engine.resumeCheckpoint(run.runId, "before-submit");
  const settled = await engine.settle(run.runId, { timeoutMs: 100 });

  assert.equal(settled.status, "settled");
  assert.deepEqual(engine.readEffects(run.runId), []);
  assert.deepEqual(inspectToolCalls(engine.readLedger(run.runId)), {
    runId: run.runId, requested: 1, started: 0, completed: 0, complete: true,
  });
  await engine.close();
});

test("stop after-submit is immediately unknown and never manufactures a barrier", async () => {
  const engine = createRunEngine();
  const run = engine.createRun();
  engine.pauseCheckpoint(run.runId, "after-submit");
  engine.decide(run.runId, "approve");
  const open = engine.readLedger(run.runId);
  assert.equal(open.events.filter((event) => event.phase === "started").length, 1);
  assert.equal(open.complete, false);

  const stopped = engine.stop(run.runId);
  assert.equal(stopped.outcome, "unknown");
  assert.equal(stopped.settled, false);
  assert.throws(() => inspectToolCalls(engine.readLedger(run.runId)), LedgerIncompleteError);
  engine.resumeCheckpoint(run.runId, "after-submit");
  assert.equal((await engine.settle(run.runId, { timeoutMs: 100 })).status, "settled");
  assert.ok(engine.readEffects(run.runId).length <= 1);
  assert.throws(() => inspectToolCalls(engine.readLedger(run.runId)), LedgerIncompleteError);
  await engine.close();
});

test("emergency after-effect preserves the effect and lets the accepted operation finish", async () => {
  const engine = createRunEngine();
  const run = engine.createRun();
  engine.pauseCheckpoint(run.runId, "after-effect");
  engine.decide(run.runId, "approve");
  assert.equal(engine.readEffects(run.runId).length, 1);

  const stopped = engine.stop(run.runId, { mode: "emergency" });
  assert.equal(stopped.outcome, "executed");
  assert.equal(stopped.mode, "emergency");
  engine.resumeCheckpoint(run.runId, "after-effect");
  await engine.settle(run.runId, { timeoutMs: 100 });
  assert.equal(engine.readEffects(run.runId).length, 1);
  assert.equal(inspectToolCalls(engine.readLedger(run.runId)).completed, 1);
  await engine.close();
});

test("eight approvals share one executor and repeated stop, resume, and settle never replay", async () => {
  const engine = createRunEngine();
  const run = engine.createRun();
  engine.pauseCheckpoint(run.runId, "after-submit");
  const decisions = Array.from({ length: 8 }, () => engine.decide(run.runId, "approve"));
  assert.ok(decisions.every((item) => item.callId === run.callId));
  assert.equal(engine.readLedger(run.runId).events.filter((event) => event.phase === "started").length, 1);

  const firstStop = engine.stop(run.runId);
  assert.equal(engine.stop(run.runId, { mode: "emergency" }), firstStop);
  engine.resumeCheckpoint(run.runId, "after-submit");
  engine.resumeCheckpoint(run.runId, "after-submit");
  const [first, second] = await Promise.all([
    engine.settle(run.runId, { timeoutMs: 100 }),
    engine.settle(run.runId, { timeoutMs: 100 }),
  ]);
  assert.equal(first.status, "settled");
  assert.deepEqual(second, first);
  assert.ok(engine.readEffects(run.runId).length <= 1);
  await engine.close();
});

test("approve/stop ordering follows the synchronous submission boundary", async () => {
  const stoppedFirst = createRunEngine();
  const left = stoppedFirst.createRun();
  assert.equal(stoppedFirst.stop(left.runId).outcome, "notExecuted");
  assert.throws(() => stoppedFirst.decide(left.runId, "approve"), { code: "RUN_STOPPED" });
  assert.deepEqual(stoppedFirst.readEffects(left.runId), []);
  await stoppedFirst.close();

  const approvedFirst = createRunEngine();
  const right = approvedFirst.createRun();
  approvedFirst.pauseCheckpoint(right.runId, "after-submit");
  approvedFirst.decide(right.runId, "approve");
  assert.equal(approvedFirst.stop(right.runId).outcome, "unknown");
  await approvedFirst.settle(right.runId, { timeoutMs: 100 });
  await approvedFirst.close();
});

test("two runs isolate checkpoint, cancellation, ledger, and effect state", async () => {
  const engine = createRunEngine();
  const first = engine.createRun();
  const second = engine.createRun();
  engine.pauseCheckpoint(first.runId, "before-submit");
  engine.decide(first.runId, "approve");
  engine.decide(second.runId, "approve");
  engine.stop(first.runId);
  await Promise.all([
    engine.settle(first.runId, { timeoutMs: 100 }),
    engine.settle(second.runId, { timeoutMs: 100 }),
  ]);
  assert.equal(engine.readEffects(first.runId).length, 0);
  assert.equal(engine.readEffects(second.runId).length, 1);
  assert.equal(inspectToolCalls(engine.readLedger(first.runId)).started, 0);
  assert.equal(inspectToolCalls(engine.readLedger(second.runId)).started, 1);
  await engine.close();
});

test("unsettled observations cannot prove zero or one and settle timeout does not replay", async () => {
  const engine = createRunEngine();
  const run = engine.createRun();
  engine.pauseCheckpoint(run.runId, "after-submit", {
    releaseOnCancel: false,
    releaseOnClose: false,
  });
  engine.decide(run.runId, "approve");
  assert.equal((await engine.settle(run.runId, { timeoutMs: 0 })).status, "unconfirmed");
  assert.throws(() => inspectToolCalls(engine.readLedger(run.runId)), LedgerIncompleteError);
  assert.deepEqual(engine.readEffects(run.runId), []);

  engine.resumeCheckpoint(run.runId, "after-submit");
  assert.equal((await engine.settle(run.runId, { timeoutMs: 100 })).status, "settled");
  assert.equal(engine.readEffects(run.runId).length, 1);
  assert.equal(inspectToolCalls(engine.readLedger(run.runId)).completed, 1);
  await engine.close();
});

test("absolute deadline expiry is sampled before submit even when its timer never fires", async () => {
  const time = controlledClock();
  const engine = createRunEngine({ executionClock: time.clock });
  const run = engine.createRun();
  engine.pauseCheckpoint(run.runId, "before-submit");
  engine.decide(run.runId, "approve");
  time.set(60_001);
  engine.resumeCheckpoint(run.runId, "before-submit");
  await engine.settle(run.runId, { timeoutMs: 100 });

  assert.equal(time.fired, 0, "deadline scheduler callback must remain undelivered");
  assert.equal(engine.readEffects(run.runId).length, 0);
  assert.equal(inspectToolCalls(engine.readLedger(run.runId)).started, 0);
  assert.equal((await engine.settle(run.runId, { timeoutMs: 0 })).submitted, false);
  await engine.close();
});

test("absolute deadline expiry after-effect cannot erase the effect", async () => {
  const time = controlledClock();
  const engine = createRunEngine({ executionClock: time.clock });
  const run = engine.createRun();
  engine.pauseCheckpoint(run.runId, "after-effect");
  engine.decide(run.runId, "approve");
  assert.equal(engine.readEffects(run.runId).length, 1);
  time.set(60_001);
  engine.resumeCheckpoint(run.runId, "after-effect");
  await engine.settle(run.runId, { timeoutMs: 100 });

  assert.equal(time.fired, 0, "deadline scheduler callback must remain undelivered");
  assert.equal(engine.readEffects(run.runId).length, 1);
  assert.equal(inspectToolCalls(engine.readLedger(run.runId)).completed, 1);
  await engine.close();
});

test("settle keeps a pending run unconfirmed and its old receipt never changes", async () => {
  const engine = createRunEngine();
  const run = engine.createRun();
  const pending = await engine.settle(run.runId, { timeoutMs: 0 });
  assert.equal(pending.status, "unconfirmed");
  assert.equal(pending.settled, false);
  assert.equal(pending.run.status, "awaiting-approval");
  assert.ok(Object.isFrozen(pending));

  engine.decide(run.runId, "approve");
  const completed = await engine.settle(run.runId, { timeoutMs: 100 });
  assert.equal(completed.status, "settled");
  assert.equal(engine.readEffects(run.runId).length, 1);
  assert.equal(pending.status, "unconfirmed");
  assert.equal(pending.settled, false);
  assert.equal(pending.run.status, "awaiting-approval");
  await engine.close();
});

test("checkpoint failures before and after submission never forge completed", async () => {
  for (const checkpoint of ["before-submit", "after-submit", "after-effect"]) {
    const engine = createRunEngine();
    const run = engine.createRun();
    engine.failCheckpoint(run.runId, checkpoint, `fail ${checkpoint}`);
    assert.equal(engine.decide(run.runId, "approve").status, "failed");
    await engine.settle(run.runId, { timeoutMs: 100 });
    const ledger = engine.readLedger(run.runId);
    assert.equal(ledger.events.some((event) => event.phase === "completed"), false);
    if (checkpoint === "before-submit") {
      assert.equal(inspectToolCalls(ledger).completed, 0);
    } else {
      assert.throws(() => inspectToolCalls(ledger), LedgerIncompleteError);
    }
    assert.equal(engine.readEffects(run.runId).length, checkpoint === "after-effect" ? 1 : 0);
    await engine.close();
  }
});

test("ended snapshots stay frozen after repeated drains", async () => {
  const engine = createRunEngine();
  const run = engine.createRun();
  engine.decide(run.runId, "approve");
  await engine.settle(run.runId, { timeoutMs: 100 });
  const state = engine.getRun(run.runId);
  const ledger = engine.readLedger(run.runId);
  const effects = engine.readEffects(run.runId);
  for (let index = 0; index < 4; index += 1) {
    await engine.settle(run.runId, { timeoutMs: 100 });
    assert.deepEqual(engine.getRun(run.runId), state);
    assert.deepEqual(engine.readLedger(run.runId), ledger);
    assert.deepEqual(engine.readEffects(run.runId), effects);
  }
  await engine.close();
});

test("HTTP exposes run-scoped checkpoint, stop, emergency, and settle controls", async () => {
  const app = await startReferenceAgent();
  try {
    const run = app.createRun();
    assert.equal((await post(app, run.runId, "control", {
      action: "pause", checkpoint: "after-submit",
    })).status, 200);
    app.decide(run.runId, "approve");
    const stopped = await post(app, run.runId, "stop", { mode: "stop" });
    assert.equal(stopped.body.outcome, "unknown");
    const repeated = await post(app, run.runId, "emergency", {});
    assert.deepEqual(repeated.body, stopped.body);
    await post(app, run.runId, "control", { action: "resume", checkpoint: "after-submit" });
    const settled = await post(app, run.runId, "settle", { timeoutMs: 100 });
    assert.equal(settled.body.status, "settled");
  } finally {
    await app.close();
  }
});

test("close releases cooperative checkpoints, but rejects unconfirmed work after HTTP closes", async () => {
  const cooperative = await startReferenceAgent();
  const first = cooperative.createRun();
  cooperative.pauseCheckpoint(first.runId, "after-submit");
  cooperative.decide(first.runId, "approve");
  await cooperative.close({ timeoutMs: 100 });
  assert.equal((await cooperative.settle(first.runId, { timeoutMs: 100 })).status, "settled");

  const blocked = await startReferenceAgent();
  const second = blocked.createRun();
  blocked.pauseCheckpoint(second.runId, "after-submit", {
    releaseOnCancel: false,
    releaseOnClose: false,
  });
  blocked.decide(second.runId, "approve");
  const closing = blocked.close({ timeoutMs: 0 });
  assert.equal(blocked.close({ timeoutMs: 100 }), closing, "first close budget and Promise are shared");
  await assert.rejects(closing, { code: "CLOSE_UNCONFIRMED" });
  await assert.rejects(fetch(blocked.baseUrl));
  blocked.resumeCheckpoint(second.runId, "after-submit");
  await blocked.settle(second.runId, { timeoutMs: 100 });
});

async function post(app, runId, resource, body) {
  const response = await fetch(`${app.baseUrl}/api/runs/${runId}/${resource}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function controlledClock() {
  let now = 0;
  let fired = 0;
  const alarms = new Set();
  return {
    clock: {
      now: () => now,
      schedule(callback) {
        const alarm = { callback };
        alarms.add(alarm);
        return () => alarms.delete(alarm);
      },
    },
    set(value) { now = value; },
    get fired() { return fired; },
    fire() {
      fired += 1;
      for (const alarm of [...alarms]) alarm.callback();
    },
  };
}
