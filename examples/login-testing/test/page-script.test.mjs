import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { ACCOUNT_EMAILS } from "../src/engine.mjs";
import { loginPage } from "../src/page.mjs";

function deferredFetch() {
  const requests = [];
  const fetch = (path, options = {}) => new Promise((resolve) => {
    requests.push({
      path,
      options,
      respond(status, body) {
        resolve({
          ok: status >= 200 && status < 300,
          status,
          json: async () => structuredClone(body),
        });
      },
    });
  });
  return { fetch, requests };
}

function element(textContent = "") {
  const listeners = new Map();
  return {
    textContent,
    value: "",
    hidden: false,
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatch(type = "click") {
      const listener = listeners.get(type);
      if (!listener) throw new Error(`No ${type} listener`);
      return listener();
    },
  };
}

function harness(entryPoint = "welcome") {
  const html = loginPage(entryPoint);
  const scriptMatch = /<script>([\s\S]*)<\/script><\/body><\/html>$/.exec(html);
  assert.ok(scriptMatch, "generated page must contain its executable script");
  const elements = new Map();
  for (const match of html.matchAll(/data-testid="([^"]+)"/g)) {
    if (!elements.has(match[1])) elements.set(match[1], element());
  }
  elements.get("email.new").textContent = ACCOUNT_EMAILS.new;
  elements.get("email.existing").textContent = ACCOUNT_EMAILS.existing;
  elements.get("captcha.mode").textContent = "test";
  elements.get("captcha.token").textContent = "fixture-pass";
  elements.get("mailbox.count").textContent = "0";
  const transport = deferredFetch();
  const historyCalls = [];
  const document = {
    body: { dataset: { entryPoint } },
    querySelector(selector) {
      const match = /^\[data-testid="([^"]+)"\]$/.exec(selector);
      return match ? elements.get(match[1]) : null;
    },
  };
  vm.runInNewContext(scriptMatch[1], {
    document,
    fetch: transport.fetch,
    history: { replaceState: (...args) => historyCalls.push(args) },
    location: { href: `http://fixture.test/login/${entryPoint}` },
    URL,
    encodeURIComponent,
    structuredClone,
  });
  return {
    elements,
    requests: transport.requests,
    historyCalls,
    click: (id) => elements.get(id).dispatch(),
  };
}

function observation(runId, attemptId, stage = "awaiting-test-captcha") {
  return {
    schemaVersion: "login-observation/1",
    identity: { runId, attemptId },
    input: { accountType: "existing", email: ACCOUNT_EMAILS.existing },
    ui: { entryPoint: "welcome", displayedScreen: "test-captcha", displayedStatus: "Ready" },
    backend: {
      flow: null, stage, emailDeliveryCount: 0, sessionCreated: false,
      effects: [{ type: "attempt.created" }],
    },
    completeness: { ui: true, backend: true, mailbox: true, settled: false },
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("latest concurrent account start exclusively owns run and attempt UI", async () => {
  const page = harness();
  const firstClick = page.click("account.new");
  const secondClick = page.click("account.existing");
  assert.equal(page.requests.length, 2);

  page.requests[1].respond(201, { runId: "run-000002" });
  await flush();
  assert.equal(page.requests[2].path, "/api/runs/run-000002/attempts");
  page.requests[2].respond(201, observation("run-000002", "run-000002-attempt-000001"));
  await secondClick;

  page.requests[0].respond(201, { runId: "run-000001" });
  await firstClick;
  assert.equal(page.requests.length, 3, "stale run response must not create an attempt");
  assert.equal(page.elements.get("run.id").textContent, "run-000002");
  assert.equal(page.elements.get("attempt.id").textContent, "run-000002-attempt-000001");
  assert.equal(page.elements.get("login.error").textContent, "");
  assert.equal(page.historyCalls.length, 1);
});

test("attempt response identity must match the selected run", async () => {
  const page = harness();
  const click = page.click("account.existing");
  page.requests[0].respond(201, { runId: "run-000001" });
  await flush();
  page.requests[1].respond(201, observation("run-999999", "run-999999-attempt-000001"));
  await click;
  assert.equal(page.elements.get("attempt.id").textContent, "");
  assert.match(page.elements.get("login.error").textContent, /IDENTITY_MISMATCH/);
  assert.equal(page.historyCalls.length, 0);
});

test("new flow clears old attempt UI and stale mailbox cannot refill it", async () => {
  const page = harness();
  const initialClick = page.click("account.existing");
  page.requests[0].respond(201, { runId: "run-000001" });
  await flush();
  page.requests[1].respond(201, observation("run-000001", "run-000001-attempt-000001"));
  await initialClick;

  page.elements.get("code.input").value = "700001";
  page.elements.get("mailbox.count").textContent = "1";
  page.elements.get("session.id").textContent = "old-session";
  page.elements.get("observation.json").textContent = "old-observation";
  const mailboxClick = page.click("mailbox.refresh");
  assert.match(page.requests[2].path, /attempt-000001\/mailbox$/);

  const nextClick = page.click("account.new");
  assert.equal(page.elements.get("code.input").value, "");
  assert.equal(page.elements.get("mailbox.count").textContent, "0");
  assert.equal(page.elements.get("session.id").textContent, "");
  assert.equal(page.elements.get("observation.json").textContent, "{}");
  assert.equal(page.elements.get("attempt.id").textContent, "");

  page.requests[2].respond(200, {
    schemaVersion: "login-mailbox/1",
    runId: "run-000001",
    attemptId: "run-000001-attempt-000001",
    complete: true,
    messages: [{ code: "700001" }],
  });
  await mailboxClick;
  assert.equal(page.elements.get("code.input").value, "", "stale mailbox must not refill code");
  assert.equal(page.elements.get("mailbox.count").textContent, "0");

  assert.equal(page.requests[3].path, "/api/runs/run-000001/attempts");
  page.requests[3].respond(201, observation("run-000001", "run-000001-attempt-000002"));
  await nextClick;
  assert.equal(page.elements.get("attempt.id").textContent, "run-000001-attempt-000002");
  assert.equal(page.elements.get("code.input").value, "");
  assert.equal(page.elements.get("session.id").textContent, "");
});
