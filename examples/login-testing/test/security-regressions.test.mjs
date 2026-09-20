import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_EMAILS, TEST_CAPTCHA, createLoginEngine } from "../src/index.mjs";
import {
  createAttempt, createRun, fixture, mailbox, passCaptcha, post, request,
} from "./helpers.mjs";

const existingInput = {
  entryPoint: "welcome",
  accountType: "existing",
  email: ACCOUNT_EMAILS.existing,
};

test("engine codes are unique across runs and remain bound to their attempt", () => {
  const engine = createLoginEngine();
  const firstRun = engine.createRun();
  const secondRun = engine.createRun();
  const first = engine.createAttempt(firstRun.runId, existingInput);
  const second = engine.createAttempt(secondRun.runId, existingInput);
  engine.completeCaptcha(firstRun.runId, first.identity.attemptId, TEST_CAPTCHA);
  engine.completeCaptcha(secondRun.runId, second.identity.attemptId, TEST_CAPTCHA);
  const firstCode = engine.getMailbox(firstRun.runId, first.identity.attemptId).messages[0].code;
  const secondCode = engine.getMailbox(secondRun.runId, second.identity.attemptId).messages[0].code;
  assert.notEqual(firstCode, secondCode);
  assert.throws(
    () => engine.verifyCode(secondRun.runId, second.identity.attemptId, { code: firstCode }),
    { code: "INVALID_VERIFICATION_CODE", status: 401 },
  );
  assert.equal(engine.getObservation(secondRun.runId, second.identity.attemptId).backend.sessionCreated, false);
  assert.equal(
    engine.verifyCode(secondRun.runId, second.identity.attemptId, { code: secondCode }).backend.stage,
    "authenticated",
  );

  const missingRun = engine.createRun({ faults: { omitVerificationEmail: true } });
  const missing = engine.createAttempt(missingRun.runId, existingInput);
  engine.completeCaptcha(missingRun.runId, missing.identity.attemptId, TEST_CAPTCHA);
  assert.deepEqual(engine.getMailbox(missingRun.runId, missing.identity.attemptId).messages, []);
  assert.throws(
    () => engine.verifyCode(missingRun.runId, missing.identity.attemptId, { code: firstCode }),
    { code: "INVALID_VERIFICATION_CODE", status: 401 },
  );
});

test("HTTP rejects a code copied from another run, including missing-mail attempts", async (t) => {
  const app = await fixture(t);
  const firstRun = await createRun(app);
  const first = await createAttempt(app, firstRun.runId);
  await passCaptcha(app, firstRun.runId, first.identity.attemptId);
  const firstCode = (await mailbox(app, firstRun.runId, first.identity.attemptId)).body.messages[0].code;

  const secondRun = await createRun(app, { omitVerificationEmail: true });
  const second = await createAttempt(app, secondRun.runId);
  await passCaptcha(app, secondRun.runId, second.identity.attemptId);
  assert.deepEqual((await mailbox(app, secondRun.runId, second.identity.attemptId)).body.messages, []);
  const copied = await post(app,
    `/api/runs/${secondRun.runId}/attempts/${second.identity.attemptId}/verify`,
    { code: firstCode });
  assert.equal(copied.status, 401);
  assert.equal(copied.body.error.code, "INVALID_VERIFICATION_CODE");
  const observation = await request(app,
    `/api/runs/${secondRun.runId}/attempts/${second.identity.attemptId}/observation`);
  assert.equal(observation.body.backend.stage, "awaiting-verification-code");
  assert.equal(observation.body.backend.sessionCreated, false);
});

test("attempt fields reject array and non-string coercion through engine and HTTP", async (t) => {
  const engine = createLoginEngine();
  const directRun = engine.createRun();
  for (const input of [
    { ...existingInput, accountType: ["existing"] },
    { ...existingInput, entryPoint: ["welcome"] },
    { ...existingInput, email: [ACCOUNT_EMAILS.existing] },
  ]) {
    assert.throws(() => engine.createAttempt(directRun.runId, input), { code: /INVALID_/ });
  }
  assert.deepEqual(engine.getRun(directRun.runId).attemptIds, []);

  const app = await fixture(t);
  const run = await createRun(app);
  for (const [field, value] of [
    ["accountType", ["existing"]],
    ["entryPoint", ["welcome"]],
    ["email", [ACCOUNT_EMAILS.existing]],
  ]) {
    const invalid = await post(app, `/api/runs/${run.runId}/attempts`, {
      ...existingInput, [field]: value,
    });
    assert.equal(invalid.status, 400);
  }
  assert.deepEqual((await request(app, `/api/runs/${run.runId}`)).body.attemptIds, []);
});

test("JSON Content-Type requires the exact media type and permits valid parameters", async (t) => {
  const app = await fixture(t);
  for (const contentType of ["application/jsonp", "application/json-invalid", "application/json;"]) {
    const response = await fetch(`${app.baseUrl}/api/runs`, {
      method: "POST", headers: { "content-type": contentType }, body: "{}",
    });
    assert.equal(response.status, 415, contentType);
    assert.equal((await response.json()).error.code, "INVALID_CONTENT_TYPE");
  }
  for (const contentType of [
    "application/json",
    "application/json; charset=utf-8",
    "Application/JSON; charset=\"utf-8\"",
  ]) {
    const response = await fetch(`${app.baseUrl}/api/runs`, {
      method: "POST", headers: { "content-type": contentType }, body: "{}",
    });
    assert.equal(response.status, 201, contentType);
  }
});

test("state transitions are single-use and reset invalidates old codes", async (t) => {
  const app = await fixture(t);
  const run = await createRun(app);
  const first = await createAttempt(app, run.runId);
  const firstId = first.identity.attemptId;
  assert.equal((await post(app, `/api/runs/${run.runId}/attempts/${firstId}/verify`, {
    code: "700001",
  })).status, 409);
  assert.equal((await passCaptcha(app, run.runId, firstId)).status, 200);
  assert.equal((await passCaptcha(app, run.runId, firstId)).status, 409);
  const oldCode = (await mailbox(app, run.runId, firstId)).body.messages[0].code;

  await post(app, `/api/runs/${run.runId}/reset`, {});
  const second = await createAttempt(app, run.runId);
  const secondId = second.identity.attemptId;
  await passCaptcha(app, run.runId, secondId);
  const newCode = (await mailbox(app, run.runId, secondId)).body.messages[0].code;
  assert.notEqual(oldCode, newCode);
  assert.equal((await post(app, `/api/runs/${run.runId}/attempts/${secondId}/verify`, {
    code: oldCode,
  })).status, 401);
  assert.equal((await post(app, `/api/runs/${run.runId}/attempts/${secondId}/verify`, {
    code: newCode,
  })).status, 200);
  assert.equal((await post(app, `/api/runs/${run.runId}/attempts/${secondId}/verify`, {
    code: newCode,
  })).status, 409);
  const final = await request(app, `/api/runs/${run.runId}/attempts/${secondId}/observation`);
  assert.equal(final.body.backend.effects.filter((effect) => effect.type === "session.created").length, 1);
});
