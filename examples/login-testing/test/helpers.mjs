import { ACCOUNT_EMAILS, TEST_CAPTCHA, startLoginFixture } from "../src/index.mjs";

export async function fixture(t) {
  const app = await startLoginFixture();
  t.after(() => app.close());
  return app;
}

export async function request(app, path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(app.baseUrl + path, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

export const post = (app, path, body = {}) => request(app, path, { method: "POST", body });

export async function createRun(app, faults) {
  const result = await post(app, "/api/runs", faults === undefined ? {} : { faults });
  if (result.status !== 201) throw new Error(JSON.stringify(result.body));
  return result.body;
}

export async function createAttempt(app, runId, {
  entryPoint = "welcome",
  accountType = "existing",
} = {}) {
  const result = await post(app, `/api/runs/${runId}/attempts`, {
    entryPoint,
    accountType,
    email: ACCOUNT_EMAILS[accountType],
  });
  if (result.status !== 201) throw new Error(JSON.stringify(result.body));
  return result.body;
}

export async function passCaptcha(app, runId, attemptId) {
  return post(app, `/api/runs/${runId}/attempts/${attemptId}/captcha`, TEST_CAPTCHA);
}

export async function mailbox(app, runId, attemptId) {
  return request(app, `/api/runs/${runId}/attempts/${attemptId}/mailbox`);
}

export async function finish(app, observation) {
  const { runId, attemptId } = observation.identity;
  const captcha = await passCaptcha(app, runId, attemptId);
  const mail = await mailbox(app, runId, attemptId);
  const verified = await post(app, `/api/runs/${runId}/attempts/${attemptId}/verify`, {
    code: mail.body.messages[0].code,
  });
  const session = await request(app, `/api/runs/${runId}/attempts/${attemptId}/session`);
  return { captcha, mail, verified, session };
}
