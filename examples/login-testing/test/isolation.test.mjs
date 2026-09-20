import assert from "node:assert/strict";
import test from "node:test";
import {
  createAttempt, createRun, fixture, mailbox, passCaptcha, post, request,
} from "./helpers.mjs";

test("concurrent attempts isolate mailbox, code, session, and detached observations", async (t) => {
  const app = await fixture(t);
  const run = await createRun(app);
  const attempts = await Promise.all([
    createAttempt(app, run.runId, { entryPoint: "welcome", accountType: "new" }),
    createAttempt(app, run.runId, { entryPoint: "account-menu", accountType: "existing" }),
  ]);
  const [firstId, secondId] = attempts.map((attempt) => attempt.identity.attemptId);
  assert.notEqual(firstId, secondId);
  const routed = await Promise.all(attempts.map((attempt) =>
    passCaptcha(app, run.runId, attempt.identity.attemptId)));
  assert.deepEqual(routed.map((result) => result.body.backend.flow), ["registration", "sign-in"]);

  const [firstMail, secondMail] = await Promise.all([
    mailbox(app, run.runId, firstId), mailbox(app, run.runId, secondId),
  ]);
  const firstCode = firstMail.body.messages[0].code;
  const secondCode = secondMail.body.messages[0].code;
  assert.notEqual(firstCode, secondCode);
  assert.equal(firstMail.body.messages[0].to, "new.user@login.fixture.test");
  assert.equal(secondMail.body.messages[0].to, "existing.user@login.fixture.test");

  const leaked = await post(app, `/api/runs/${run.runId}/attempts/${secondId}/verify`, { code: firstCode });
  assert.equal(leaked.status, 401);
  assert.equal(leaked.body.error.code, "INVALID_VERIFICATION_CODE");
  const verified = await Promise.all([
    post(app, `/api/runs/${run.runId}/attempts/${firstId}/verify`, { code: firstCode }),
    post(app, `/api/runs/${run.runId}/attempts/${secondId}/verify`, { code: secondCode }),
  ]);
  assert.ok(verified.every((result) => result.body.backend.sessionCreated));
  const sessions = await Promise.all([
    request(app, `/api/runs/${run.runId}/attempts/${firstId}/session`),
    request(app, `/api/runs/${run.runId}/attempts/${secondId}/session`),
  ]);
  assert.notEqual(sessions[0].body.sessionId, sessions[1].body.sessionId);

  attempts[0].backend.effects.length = 0;
  const unchanged = await request(app, `/api/runs/${run.runId}/attempts/${firstId}/observation`);
  assert.equal(unchanged.body.backend.effects.length, 4);
});

test("attempt identity cannot be used under another run", async (t) => {
  const app = await fixture(t);
  const firstRun = await createRun(app);
  const secondRun = await createRun(app);
  const attempt = await createAttempt(app, firstRun.runId);
  const attemptId = attempt.identity.attemptId;
  const crossRun = await request(app,
    `/api/runs/${secondRun.runId}/attempts/${attemptId}/observation`);
  assert.equal(crossRun.status, 404);
  assert.equal(crossRun.body.error.code, "ATTEMPT_NOT_FOUND");
});

test("reset removes attempt-scoped secrets and does not reuse attempt IDs", async (t) => {
  const app = await fixture(t);
  const run = await createRun(app, { omitVerificationEmail: true });
  const before = await createAttempt(app, run.runId);
  const beforeId = before.identity.attemptId;
  await passCaptcha(app, run.runId, beforeId);
  const reset = await post(app, `/api/runs/${run.runId}/reset`, {});
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.body.removedAttemptIds, [beforeId]);
  assert.equal(reset.body.resetGeneration, 1);
  assert.equal((await mailbox(app, run.runId, beforeId)).status, 404);

  const after = await createAttempt(app, run.runId);
  assert.notEqual(after.identity.attemptId, beforeId);
  const delivered = await passCaptcha(app, run.runId, after.identity.attemptId);
  assert.equal(delivered.body.backend.emailDeliveryCount, 1);
  const runState = await request(app, `/api/runs/${run.runId}`);
  assert.deepEqual(runState.body.faults, {
    misrouteExistingToRegistration: false,
    omitVerificationEmail: false,
  });
});
