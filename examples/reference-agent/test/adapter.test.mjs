import assert from "node:assert/strict";
import test from "node:test";

import { assertObservation, expectAgent } from "@surfaceloom/test";
import {
  ReferenceAgentBrowserAdapter,
  referenceAgentLocalResource,
  referenceAgentToolId,
  runBarrier,
} from "../adapter/reference-agent-browser.mjs";
import { startReferenceAgent } from "../src/index.mjs";

async function fixture(t) {
  const app = await startReferenceAgent();
  t.after(() => app.close());
  return app;
}

function observingSession(app, runId, onRead = () => {}) {
  return {
    async text(locator) {
      onRead(locator);
      if (locator.key === "run.snapshot") {
        const run = app.getRun(runId);
        return JSON.stringify({ runId: run.runId, callId: run.callId,
          status: run.status, approvalRequested: true });
      }
      throw new Error(`Unexpected locator: ${locator.key}`);
    },
  };
}

test("adapter binds public Agent assertions to exact run and call identities", async (t) => {
  const app = await fixture(t);
  const created = app.createRun();
  const adapter = new ReferenceAgentBrowserAdapter(observingSession(app, created.runId), app.baseUrl);
  const agent = await adapter.bindRun(created.runId);
  const barrier = runBarrier(created.runId);

  assert.equal((await expectAgent(agent).toHaveRunState("awaiting-approval")).status, "passed");
  assert.equal((await expectAgent(agent).toHaveRequestedApproval()).status, "passed");
  app.decide(created.runId, "approve");

  assert.equal(agent.runId, created.runId);
  assert.equal(agent.tool(referenceAgentToolId).callId, created.callId);
  assert.equal((await expectAgent(agent).toHaveRunState("completed")).status, "passed");
  assert.equal((await expectAgent(agent.tool(referenceAgentToolId))
    .toHaveExecutedExactlyOnce({ barrier })).status, "passed");
});

test("run state and approval use one strict atomic UI snapshot read", async (t) => {
  const app = await fixture(t);
  const first = app.createRun();
  const second = app.createRun();
  let reads = 0;
  const switched = new ReferenceAgentBrowserAdapter(
    observingSession(app, second.runId, () => { reads += 1; }), app.baseUrl,
  );

  const state = await switched.readRunState({ runId: first.runId });
  const approval = await switched.readApproval({ runId: first.runId, callId: first.callId });
  assert.equal(state.state, "unknown");
  assert.equal(approval.state, "unknown");
  assert.equal(reads, 2, "each provider read must consume exactly one atomic snapshot");

  const malformed = new ReferenceAgentBrowserAdapter({
    text: async () => JSON.stringify({
      runId: first.runId, callId: first.callId, status: "completed",
      approvalRequested: true, unexpected: "field",
    }),
  }, app.baseUrl);
  assert.equal((await malformed.readRunState({ runId: first.runId })).state, "unknown");
  assert.equal((await malformed.readApproval({
    runId: first.runId, callId: first.callId,
  })).state, "unknown");
});

test("denied tool and local resource observations share one complete run barrier", async (t) => {
  const app = await fixture(t);
  const created = app.createRun();
  const adapter = new ReferenceAgentBrowserAdapter(observingSession(app, created.runId), app.baseUrl);
  const agent = await adapter.bindRun(created.runId);
  const tool = agent.tool(referenceAgentToolId);
  const barrier = runBarrier(created.runId);

  app.decide(created.runId, "deny");

  const [toolResult, resourceResult] = await Promise.all([
    assertObservation((context) => adapter.readToolCall(
      { runId: created.runId, callId: tool.callId }, context,
    ), {
      expectation: {
        kind: "negative-value",
        expected: { runId: created.runId, callId: tool.callId, requested: 1, started: 0, completed: 0 },
        matches: (value) => value.requested === 1 && value.started === 0 && value.completed === 0,
        completeness: barrier,
      },
      timeoutMs: 50,
    }),
    assertObservation((context) => adapter.readLocalEffects(
      { runId: created.runId, resource: referenceAgentLocalResource }, context,
    ), {
      expectation: {
        kind: "negative-value",
        expected: {
          runId: created.runId, resource: referenceAgentLocalResource, boundary: "local", count: 0,
        },
        matches: (value) => value.boundary === "local" && value.count === 0,
        completeness: barrier,
      },
      timeoutMs: 50,
    }),
  ]);

  assert.equal(toolResult.status, "passed");
  assert.equal(resourceResult.status, "passed");
  assert.deepEqual(toolResult.actual.observation.completeness, { ...barrier, complete: true });
  assert.deepEqual(resourceResult.actual.observation.completeness, { ...barrier, complete: true });
  const external = await adapter.readExternalEffects(
    { runId: created.runId, resource: referenceAgentLocalResource },
  );
  assert.equal(external.state, "unknown");
  assert.match(external.reason, /local/u);
});

test("incomplete ledger keeps both exact-call and local-resource counts unknown", async (t) => {
  const app = await fixture(t);
  const created = app.createRun({ fault: "incomplete-ledger" });
  const adapter = new ReferenceAgentBrowserAdapter(observingSession(app, created.runId), app.baseUrl);
  const agent = await adapter.bindRun(created.runId);
  app.decide(created.runId, "deny");

  const call = await adapter.readToolCall({
    runId: created.runId, callId: agent.tool(referenceAgentToolId).callId,
  });
  const resource = await adapter.readLocalEffects({
    runId: created.runId, resource: referenceAgentLocalResource,
  });
  assert.equal(call.state, "unknown");
  assert.equal(resource.state, "unknown");
  assert.match(call.reason, /complete run boundary/u);
  assert.match(resource.reason, /complete run boundary/u);
});

test("same-shaped open ledgers have identical local-effect semantics across fault labels", async (t) => {
  const app = await fixture(t);
  const normal = app.createRun({ fault: "none" });
  const labelled = app.createRun({ fault: "incomplete-ledger" });
  assert.deepEqual(app.readRawLedger(normal.runId).events.map((event) => event.phase), ["requested"]);
  assert.deepEqual(app.readRawLedger(labelled.runId).events.map((event) => event.phase), ["requested"]);
  const normalAdapter = new ReferenceAgentBrowserAdapter(
    observingSession(app, normal.runId), app.baseUrl);
  const labelledAdapter = new ReferenceAgentBrowserAdapter(
    observingSession(app, labelled.runId), app.baseUrl);
  const scope = (runId) => ({ runId, resource: referenceAgentLocalResource });
  const [normalObservation, labelledObservation] = await Promise.all([
    normalAdapter.readLocalEffects(scope(normal.runId)),
    labelledAdapter.readLocalEffects(scope(labelled.runId)),
  ]);
  assert.deepEqual(normalObservation, labelledObservation);
  assert.equal(normalObservation.state, "unknown");
  const [normalDiagnostic, labelledDiagnostic] = await Promise.all([
    normalAdapter.readRawLocalEffects(scope(normal.runId)),
    labelledAdapter.readRawLocalEffects(scope(labelled.runId)),
  ]);
  assert.deepEqual({ ...normalDiagnostic, value: { ...normalDiagnostic.value, runId: "same" } },
    { ...labelledDiagnostic, value: { ...labelledDiagnostic.value, runId: "same" } });
  assert.equal(normalDiagnostic.value.count, 0);
  assert.equal("completeness" in normalDiagnostic, false);
});
