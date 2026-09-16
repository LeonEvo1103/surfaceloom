import assert from "node:assert/strict";
import test from "node:test";
import { BrowserAutomationError } from "../src/index.js";
import { observedEvents, openSession, capture, unsettled, shape, consoleMessage, requestPayload, responsePayload } from "./observation-fixtures.js";

test("bounds the retained stream and reports what it dropped", async () => {
  const { session, page } = await openSession();
  const handle = session.observe({ limit: 3 });
  for (let index = 0; index < 10; index += 1) {
    page.emit("console", consoleMessage("error", `entry-${index}`));
  }

  const { observations, dropped } = handle.stop();

  assert.equal(observations.length, 3);
  assert.equal(dropped, 7);
  assert.deepEqual(observations.map((record) => record.text), [
    "entry-7",
    "entry-8",
    "entry-9",
  ]);
  await session.close();
});

test("rejects an observation limit that is not a positive integer", async () => {
  const { session, page } = await openSession();

  for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => session.observe({ limit }),
      (error: unknown) =>
        error instanceof BrowserAutomationError && error.code === "invalidArgument",
      `expected ${String(limit)} to be rejected`,
    );
  }
  for (const event of observedEvents) {
    assert.equal(page.events.listenerCount(event), 0);
  }
  await session.close();
});

test("automation errors never quote an observed URL or page text", async () => {
  const { session, page } = await openSession();
  const secret = "https://tenant.internal.example.test/session?token=leak";
  const handle = session.observe();
  page.emit("request", requestPayload("GET", secret));
  page.emit("response", responsePayload(500, secret, "GET"));
  page.emit("console", consoleMessage("error", `failed to load ${secret}`));

  const messages: string[] = [];
  page.target.waitFailure = new Error(secret);
  await assert.rejects(
    session.click({ key: "missing", kind: "css", selector: "#missing" }),
    (error: unknown) => capture(error, messages, "targetNotFound"),
  );

  page.target.waitFailure = undefined;
  page.target.matches = 2;
  await assert.rejects(
    session.click({ key: "duplicate", kind: "role", role: "button" }),
    (error: unknown) => capture(error, messages, "ambiguousTarget"),
  );
  assert.throws(
    () => session.observe({ limit: 0 }),
    (error: unknown) => capture(error, messages, "invalidArgument"),
  );

  await session.close();
  await assert.rejects(
    session.title(),
    (error: unknown) => capture(error, messages, "sessionClosed"),
  );
  assert.throws(
    () => session.observe(),
    (error: unknown) => capture(error, messages, "sessionClosed"),
  );

  const { observations: records } = handle.stop();
  assert.equal(records.some((record) => record.url === secret), true);
  assert.equal(messages.length, 5);
  for (const message of messages) {
    assert.equal(message.includes(secret), false);
    assert.equal(message.includes("token=leak"), false);
    assert.equal(message.includes("internal.example.test"), false);
  }
});
