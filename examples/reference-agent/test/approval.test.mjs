import assert from "node:assert/strict";
import test from "node:test";
import { inspectToolCalls, LedgerIncompleteError, startReferenceAgent } from "../src/index.mjs";

async function fixture(t) {
  const app = await startReferenceAgent();
  t.after(() => app.close());
  return app;
}

async function post(app, path, body) {
  const response = await fetch(app.baseUrl + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("deny completes the run with one request and zero executed tools", async (t) => {
  const app = await fixture(t);
  const created = await post(app, "/api/runs", {});
  assert.equal(created.status, 201);
  const { runId, callId } = created.body;
  assert.equal(created.body.status, "awaiting-approval");
  const denied = await post(app, `/api/runs/${runId}/decision`, { decision: "deny" });
  assert.equal(denied.body.status, "denied");
  assert.equal(denied.body.ended, true);
  assert.equal(denied.body.callId, callId);
  const ledger = await (await fetch(`${app.baseUrl}/api/runs/${runId}/ledger`)).json();
  assert.deepEqual(inspectToolCalls(ledger, runId), {
    runId, requested: 1, started: 0, completed: 0, complete: true,
  });
  assert.deepEqual(await (await fetch(`${app.baseUrl}/api/runs/${runId}/effects`)).json(), []);
});

test("approval executes exactly once and concurrent repeated approval is idempotent", async (t) => {
  const app = await fixture(t);
  const { runId, callId } = app.createRun();
  const responses = await Promise.all(Array.from({ length: 8 }, () =>
    post(app, `/api/runs/${runId}/decision`, { decision: "approve" })));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "completed");
  }
  assert.deepEqual(inspectToolCalls(app.readLedger(runId)), {
    runId, requested: 1, started: 1, completed: 1, complete: true,
  });
  assert.deepEqual(app.readEffects(runId), [{ runId, callId, tool: "append-note", value: "approved-note" }]);
  const conflict = await post(app, `/api/runs/${runId}/decision`, { decision: "deny" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "DECISION_CONFLICT");
  assert.equal(app.readEffects(runId).length, 1);
});

test("deny-but-execute is detected by the independent ledger despite a denied run", async (t) => {
  const app = await fixture(t);
  const { runId } = app.createRun({ fault: "deny-but-execute" });
  app.decide(runId, "deny");
  app.decide(runId, "deny");
  assert.equal(app.getRun(runId).status, "denied");
  const calls = inspectToolCalls(app.readLedger(runId), runId);
  assert.equal(calls.started, 1);
  assert.equal(calls.completed, 1);
  assert.equal(app.readEffects(runId).length, 1);
  assert.throws(() => assert.equal(calls.started, 0), assert.AssertionError);
});

test("an ended run with incomplete ledger cannot establish zero tool calls", async (t) => {
  const app = await fixture(t);
  const { runId } = app.createRun({ fault: "incomplete-ledger" });
  app.decide(runId, "deny");
  assert.equal(app.getRun(runId).ended, true);
  const ledger = app.readLedger(runId);
  assert.equal(ledger.events.filter((event) => event.phase === "started").length, 0);
  assert.equal(ledger.complete, false);
  assert.equal(ledger.endBoundary, null);
  assert.throws(() => inspectToolCalls(ledger), LedgerIncompleteError);
});

test("pending runs, detached snapshots, and separate runs preserve observation identity", async (t) => {
  const app = await fixture(t);
  const first = app.createRun();
  const second = app.createRun();
  assert.notEqual(first.runId, second.runId);
  assert.notEqual(first.callId, second.callId);
  const pending = app.readLedger(first.runId);
  assert.throws(() => inspectToolCalls(pending), LedgerIncompleteError);
  pending.events.length = 0;
  first.status = "completed";
  assert.equal(app.getRun(first.runId).status, "awaiting-approval");
  assert.equal(app.readLedger(first.runId).events.length, 1);
  app.decide(first.runId, "deny");
  app.decide(second.runId, "approve");
  assert.equal(inspectToolCalls(app.readLedger(first.runId)).started, 0);
  assert.equal(inspectToolCalls(app.readLedger(second.runId)).started, 1);
  assert.throws(() => inspectToolCalls(app.readLedger(first.runId), second.runId), LedgerIncompleteError);
});

test("close is idempotent, terminates pending runs and stops accepting connections", async () => {
  const app = await startReferenceAgent();
  const { runId } = app.createRun();
  try {
    const firstClose = app.close();
    assert.equal(app.close(), firstClose);
    await firstClose;
    assert.equal(app.getRun(runId).status, "cancelled");
    assert.equal(inspectToolCalls(app.readLedger(runId)).started, 0);
    assert.throws(() => app.createRun(), { code: "FIXTURE_CLOSED" });
    await assert.rejects(fetch(app.baseUrl));
  } finally {
    await app.close();
  }
});

test("HTTP fixture is loopback-only and exposes a same-origin approval page", async (t) => {
  const app = await fixture(t);
  const url = new URL(app.baseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.notEqual(url.port, "0");
  const response = await fetch(app.baseUrl);
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const id of ["run.start", "run.id", "run.status", "approval.approve", "approval.deny"]) {
    assert.ok(html.includes(`data-testid="${id}"`));
  }
  const crossOrigin = await fetch(`${app.baseUrl}/api/runs`, {
    method: "POST", headers: { "content-type": "application/json", origin: "https://example.invalid" },
    body: "{}",
  });
  assert.equal(crossOrigin.status, 403);
});

test("invalid HTTP requests fail without creating or executing tools", async (t) => {
  const app = await fixture(t);
  assert.equal((await post(app, "/api/runs", { fault: "random" })).status, 400);
  assert.equal((await post(app, "/api/runs", null)).status, 400);
  assert.equal((await fetch(`${app.baseUrl}/api/runs/run-999999`)).status, 404);
  const run = app.createRun();
  assert.equal(run.runId, "run-000001");
  assert.equal((await post(app, `/api/runs/${run.runId}/decision`, { decision: "maybe" })).status, 400);
  assert.equal(app.getRun(run.runId).status, "awaiting-approval");
  assert.deepEqual(app.readEffects(run.runId), []);
});
