import assert from "node:assert/strict";
import test from "node:test";
import {
  createAttempt, createRun, finish, fixture, mailbox, passCaptcha, post, request,
} from "./helpers.mjs";

test("both browser entry points expose new and existing local-account flows", async (t) => {
  const app = await fixture(t);
  const index = await fetch(app.baseUrl);
  const indexHtml = await index.text();
  assert.match(indexHtml, /data-testid="entry\.welcome"/);
  assert.match(indexHtml, /data-testid="entry\.account-menu"/);

  for (const [entryPoint, accountType, expectedFlow] of [
    ["welcome", "new", "registration"],
    ["account-menu", "existing", "sign-in"],
  ]) {
    const page = await fetch(`${app.baseUrl}/login/${entryPoint}`);
    const html = await page.text();
    assert.match(html, new RegExp(`data-testid="login\\.entry\\.${entryPoint}"`));
    assert.match(html, /data-testid="captcha\.mode">test</);
    assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/);
    const run = await createRun(app);
    const attempt = await createAttempt(app, run.runId, { entryPoint, accountType });
    assert.equal(attempt.backend.stage, "awaiting-test-captcha");
    const result = await finish(app, attempt);
    assert.equal(result.captcha.body.backend.flow, expectedFlow);
    assert.equal(result.mail.body.messages.length, 1);
    assert.equal(result.verified.body.ui.displayedScreen, "account-home");
    assert.equal(result.session.body.accountType, accountType);
    assert.equal(result.session.body.flow, expectedFlow);
  }
});

test("the same normal login completes twice with stable, distinct identities", async (t) => {
  const app = await fixture(t);
  const run = await createRun(app);
  const results = [];
  for (let index = 0; index < 2; index += 1) {
    const attempt = await createAttempt(app, run.runId, {
      entryPoint: "welcome", accountType: "existing",
    });
    results.push({ attempt, completed: await finish(app, attempt) });
  }
  assert.notEqual(results[0].attempt.identity.attemptId, results[1].attempt.identity.attemptId);
  assert.equal(results[0].attempt.identity.runId, results[1].attempt.identity.runId);
  for (const result of results) {
    assert.equal(result.completed.verified.body.backend.flow, "sign-in");
    assert.equal(result.completed.verified.body.backend.stage, "authenticated");
    assert.equal(result.completed.verified.body.backend.emailDeliveryCount, 1);
  }
  assert.notEqual(results[0].completed.session.body.sessionId, results[1].completed.session.body.sessionId);
});

test("observation separates displayed UI facts from backend flow and effects", async (t) => {
  const app = await fixture(t);
  const run = await createRun(app, { misrouteExistingToRegistration: true });
  const attempt = await createAttempt(app, run.runId, { accountType: "existing" });
  const routed = await passCaptcha(app, run.runId, attempt.identity.attemptId);
  assert.deepEqual(routed.body.input, {
    accountType: "existing", email: "existing.user@login.fixture.test",
  });
  assert.equal(routed.body.ui.displayedScreen, "registration-code");
  assert.equal(routed.body.ui.displayedStatus, "Verification code sent");
  assert.equal(routed.body.backend.flow, "registration");
  assert.deepEqual(routed.body.backend.effects.map((effect) => effect.type), [
    "attempt.created", "flow.selected", "email.delivered",
  ]);
  assert.deepEqual(routed.body.completeness, {
    ui: true, backend: true, mailbox: true, settled: false,
  });
  assert.equal("rootCause" in routed.body, false);
  assert.doesNotMatch(JSON.stringify(routed.body), /misroute|fault|cause/i);
});

test("both injected faults can be disabled and subsequent attempts recover", async (t) => {
  const app = await fixture(t);
  const run = await createRun(app, {
    misrouteExistingToRegistration: true,
    omitVerificationEmail: true,
  });
  const faulty = await createAttempt(app, run.runId, { accountType: "existing" });
  const faultyRouted = await passCaptcha(app, run.runId, faulty.identity.attemptId);
  assert.equal(faultyRouted.body.ui.displayedStatus, "Verification code sent");
  assert.equal(faultyRouted.body.backend.flow, "registration");
  assert.equal(faultyRouted.body.backend.emailDeliveryCount, 0);
  assert.deepEqual((await mailbox(app, run.runId, faulty.identity.attemptId)).body.messages, []);

  const updated = await post(app, `/api/runs/${run.runId}/faults`, {
    misrouteExistingToRegistration: false,
    omitVerificationEmail: false,
  });
  assert.equal(updated.status, 200);
  const recovered = await createAttempt(app, run.runId, { accountType: "existing" });
  const completed = await finish(app, recovered);
  assert.equal(completed.verified.body.backend.flow, "sign-in");
  assert.equal(completed.mail.body.messages.length, 1);

  const original = await request(app,
    `/api/runs/${run.runId}/attempts/${faulty.identity.attemptId}/observation`);
  assert.equal(original.body.backend.flow, "registration");
  assert.equal(original.body.backend.emailDeliveryCount, 0);
});
