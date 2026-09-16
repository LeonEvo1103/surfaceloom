import assert from "node:assert/strict";
import test from "node:test";
import { BrowserAutomationError } from "../src/index.js";
import { observedEvents, openSession, capture, unsettled, shape, consoleMessage, requestPayload, responsePayload } from "./observation-fixtures.js";

test("stop() is idempotent and detaches exactly once", async () => {
  const { session, page } = await openSession();
  const handle = session.observe();
  page.emit("console", consoleMessage("error", "only entry"));

  const first = handle.stop();
  page.emit("console", consoleMessage("error", "arrived after stop"));
  const second = handle.stop();

  assert.deepEqual(second, first);
  assert.equal(second.observations.length, 1);
  assert.deepEqual(page.events.offCalls.slice().sort(), [...observedEvents].sort());
  assert.equal(page.events.offCalls.length, observedEvents.length);
  await session.close();
});

test("observe() rejects a closed session", async () => {
  const { session } = await openSession();
  await session.close();

  assert.throws(
    () => session.observe(),
    (error: unknown) =>
      error instanceof BrowserAutomationError && error.code === "sessionClosed",
  );
});

test("close() detaches an active subscription before tearing the session down", async () => {
  const { session, page, context } = await openSession();
  const handle = session.observe();
  page.emit("console", consoleMessage("error", "before close"));
  for (const event of observedEvents) {
    assert.equal(page.events.listenerCount(event), 1);
  }

  await session.close();

  for (const event of observedEvents) {
    assert.equal(page.events.listenerCount(event), 0);
  }
  assert.deepEqual(page.events.offCalls.slice().sort(), [...observedEvents].sort());
  assert.equal(context.closeCount, 1);
  assert.equal(handle.stop().observations.length, 1);
});

test("concurrent subscriptions share one listener set and stay independent", async () => {
  const { session, page: fake } = await openSession();
  const first = session.observe();
  fake.emit("console", consoleMessage("error", "before second"));
  const second = session.observe();
  for (const event of observedEvents) {
    assert.equal(fake.events.listenerCount(event), 1);
  }

  fake.emit("console", consoleMessage("error", "after second"));
  const firstBatch = first.stop();
  // Stopping one subscription must not orphan the other.
  for (const event of observedEvents) {
    assert.equal(fake.events.listenerCount(event), 1);
  }
  fake.emit("console", consoleMessage("error", "after first stop"));
  const secondBatch = second.stop();

  for (const event of observedEvents) {
    assert.equal(fake.events.listenerCount(event), 0);
  }
  assert.deepEqual(firstBatch.observations.map((record) => record.text), [
    "before second",
    "after second",
  ]);
  assert.deepEqual(secondBatch.observations.map((record) => record.text), [
    "after second",
    "after first stop",
  ]);
  await session.close();
});

test("a failed listener registration leaves no partial observer behind", async () => {
  const { session, page } = await openSession();
  const refused = new Error("the page refused another listener");
  // The third of the six registrations fails, so two are already on the page.
  page.onFailure = { event: "request", error: refused };

  assert.throws(() => session.observe(), (error: unknown) => error === refused);
  for (const event of observedEvents) {
    assert.equal(page.events.listenerCount(event), 0, `${event} survived the failure`);
  }

  page.onFailure = undefined;
  const handle = session.observe();
  for (const event of observedEvents) {
    assert.equal(page.events.listenerCount(event), 1, `${event} was bound twice`);
  }
  page.emit("console", consoleMessage("warning", "one signal, one record"));
  const { observations: records } = handle.stop();
  assert.equal(records.length, 1);
  // stop() can only detach once the failed attempt released its own subscription.
  for (const event of observedEvents) {
    assert.equal(page.events.listenerCount(event), 0, `${event} outlived stop()`);
  }
});
