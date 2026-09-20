import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_EMAILS } from "../src/index.mjs";
import { createAttempt, createRun, fixture, passCaptcha, post, request } from "./helpers.mjs";

test("invalid HTTP input fails without advancing the attempt", async (t) => {
  const app = await fixture(t);
  const run = await createRun(app);
  const invalidAttempt = await post(app, `/api/runs/${run.runId}/attempts`, {
    entryPoint: "unknown", accountType: "existing", email: ACCOUNT_EMAILS.existing,
  });
  assert.equal(invalidAttempt.status, 400);
  assert.deepEqual((await request(app, `/api/runs/${run.runId}`)).body.attemptIds, []);

  const externalEmail = await post(app, `/api/runs/${run.runId}/attempts`, {
    entryPoint: "welcome", accountType: "existing", email: "someone@example.com",
  });
  assert.equal(externalEmail.status, 400);
  assert.equal(externalEmail.body.error.code, "INVALID_LOCAL_EMAIL");

  const attempt = await createAttempt(app, run.runId);
  const attemptId = attempt.identity.attemptId;
  const productionCaptcha = await post(app,
    `/api/runs/${run.runId}/attempts/${attemptId}/captcha`,
    { mode: "production", token: "fixture-pass" });
  assert.equal(productionCaptcha.status, 403);
  const unchanged = await request(app,
    `/api/runs/${run.runId}/attempts/${attemptId}/observation`);
  assert.equal(unchanged.body.backend.stage, "awaiting-test-captcha");

  await passCaptcha(app, run.runId, attemptId);
  const nonStringCode = await post(app,
    `/api/runs/${run.runId}/attempts/${attemptId}/verify`, { code: 700001 });
  assert.equal(nonStringCode.status, 401);
  assert.equal((await request(app,
    `/api/runs/${run.runId}/attempts/${attemptId}/session`)).status, 404);
});

test("malformed, oversized, cross-origin, and unsupported requests are rejected", async (t) => {
  const app = await fixture(t);
  const malformed = await fetch(`${app.baseUrl}/api/runs`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "INVALID_JSON");
  const wrongType = await fetch(`${app.baseUrl}/api/runs`, {
    method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
  });
  assert.equal(wrongType.status, 415);
  const oversized = await fetch(`${app.baseUrl}/api/runs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ unused: "x".repeat(5_000) }),
  });
  assert.equal(oversized.status, 413);
  const crossOrigin = await fetch(`${app.baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://example.invalid" },
    body: "{}",
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await fetch(`${app.baseUrl}/not-found`)).status, 404);
  assert.equal((await fetch(`${app.baseUrl}/api/runs`, { method: "DELETE" })).status, 404);
  const firstRun = await createRun(app);
  assert.equal(firstRun.runId, "run-000001");
});

test("close is idempotent, clears pending secrets, and stops HTTP", async () => {
  const app = await (await import("../src/index.mjs")).startLoginFixture();
  const run = app.createRun();
  const attempt = app.createAttempt(run.runId, {
    entryPoint: "welcome", accountType: "existing", email: ACCOUNT_EMAILS.existing,
  });
  const attemptId = attempt.identity.attemptId;
  app.completeCaptcha(run.runId, attemptId, { mode: "test", token: "fixture-pass" });
  assert.equal(app.getMailbox(run.runId, attemptId).messages.length, 1);
  const firstClose = app.close();
  assert.equal(app.close(), firstClose);
  await firstClose;
  const closed = app.getObservation(run.runId, attemptId);
  assert.equal(closed.backend.stage, "cancelled");
  assert.equal(closed.backend.emailDeliveryCount, 0);
  assert.equal(closed.backend.sessionCreated, false);
  assert.deepEqual(app.getMailbox(run.runId, attemptId).messages, []);
  assert.deepEqual(app.getRun(run.runId).attemptIds, [attemptId]);
  assert.throws(() => app.getSession(run.runId, attemptId), { code: "SESSION_NOT_FOUND" });
  assert.throws(() => app.setFaults(run.runId, {}), { code: "FIXTURE_CLOSED" });
  assert.throws(() => app.createRun(), { code: "FIXTURE_CLOSED" });
  await assert.rejects(fetch(app.baseUrl));
});
