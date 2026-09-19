import assert from "node:assert/strict";
import test from "node:test";

import { approvalPage } from "../src/page.mjs";

test("a late create response cannot overwrite the newer run snapshot", async () => {
  const script = approvalPage.match(/<script type="module">([\s\S]*)<\/script>/u)?.[1];
  assert.ok(script);
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      textContent: "", hidden: false, listeners: new Map(),
      addEventListener(name, listener) { this.listeners.set(name, listener); },
    });
    return elements.get(id);
  };
  const document = {
    querySelector(selector) {
      return element(selector.match(/data-testid="([^"]+)"/u)[1]);
    },
  };
  const pending = [];
  const fetch = () => new Promise((resolve) => pending.push(resolve));
  const history = { replaceState() {} };
  const location = { href: "http://127.0.0.1/" };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("document", "fetch", "history", "location", "setTimeout", script)(
    document, fetch, history, location, setTimeout,
  );

  const click = element("run.start").listeners.get("click");
  const older = click();
  const newer = click();
  pending[1](response(run("run-000002")));
  await newer;
  pending[0](response(run("run-000001")));
  await older;

  assert.equal(JSON.parse(element("run.snapshot").textContent).runId, "run-000002");
});

function run(runId) {
  return { runId, callId: `${runId}:call-1`, status: "cancelled", decision: null, ended: true };
}

function response(value) {
  return { ok: true, status: 201, json: async () => value };
}
