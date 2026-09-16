import assert from "node:assert/strict";
import test from "node:test";
import { BrowserAutomationError } from "../src/index.js";
import { observedEvents, openSession, capture, unsettled, shape, consoleMessage, requestPayload, responsePayload } from "./observation-fixtures.js";

test("normalizes every observed page signal and keeps it sensitive", async () => {
  const { session, page } = await openSession();
  const handle = session.observe();
  const exchange = requestPayload("GET", "https://api.example.test/a");

  page.emit("console", consoleMessage("warning", "deprecated api call"));
  page.emit("pageerror", new Error("ReferenceError: total is not defined"));
  page.emit("request", exchange);
  page.emit("requestfinished", exchange);
  page.emit(
    "requestfailed",
    requestPayload("POST", "https://api.example.test/b", "net::ERR_TIMED_OUT"),
  );
  page.emit("response", responsePayload(503, "https://api.example.test/c", "GET"));

  const { observations: records, dropped } = handle.stop();
  assert.equal(dropped, 0);
  assert.deepEqual(records.map(shape), [
    {
      kind: "consoleMessage",
      level: "warning",
      text: "deprecated api call",
      sensitive: true,
    },
    {
      kind: "pageError",
      text: "ReferenceError: total is not defined",
      sensitive: true,
    },
    {
      kind: "requestStarted",
      requestId: 1,
      url: "https://api.example.test/a",
      method: "GET",
      sensitive: true,
    },
    {
      // Same Request instance as the start, so the pair shares one id.
      kind: "requestFinished",
      requestId: 1,
      url: "https://api.example.test/a",
      method: "GET",
      sensitive: true,
    },
    {
      kind: "requestFailed",
      requestId: 2,
      url: "https://api.example.test/b",
      method: "POST",
      failure: "net::ERR_TIMED_OUT",
      sensitive: true,
    },
    {
      kind: "response",
      requestId: 3,
      url: "https://api.example.test/c",
      method: "GET",
      status: 503,
      sensitive: true,
    },
  ]);
  assert.equal(
    records.every((record) => !Number.isNaN(Date.parse(record.at))),
    true,
  );
  await session.close();
});

test("returns observations in arrival order, not in event-kind order", async () => {
  const { session, page } = await openSession();
  const handle = session.observe();

  page.emit("response", responsePayload(200, "https://api.example.test/first", "GET"));
  page.emit("console", consoleMessage("info", "second"));
  page.emit("request", requestPayload("PUT", "https://api.example.test/third"));
  page.emit("console", consoleMessage("error", "fourth"));

  assert.deepEqual(handle.stop().observations.map((record) => record.kind), [
    "response",
    "consoleMessage",
    "requestStarted",
    "consoleMessage",
  ]);
  await session.close();
});

test("a faulty event payload never fails the action under test", async () => {
  const { session, page } = await openSession();
  page.gotoEmissions.push({
    event: "console",
    payload: {
      type: (): string => "error",
      text: (): string => {
        throw new Error("hostile console payload");
      },
    },
  });
  const handle = session.observe();

  const result = await session.navigate("https://example.test/page");

  assert.equal(result.url, "https://example.test/page");
  const { observations: records } = handle.stop();
  assert.deepEqual(records.map((record) => record.kind), ["pageError"]);
  assert.equal(records[0]?.text?.includes("could not be normalized"), true);
  assert.equal(records[0]?.text?.includes("hostile console payload"), false);
  await session.close();
});

test("started and finished requests let a caller derive unsettled requests", async () => {
  const { session, page } = await openSession();
  const handle = session.observe();
  const fast = requestPayload("GET", "https://api.example.test/fast");

  page.emit("request", requestPayload("GET", "https://api.example.test/slow"));
  page.emit("request", fast);
  page.emit("requestfinished", fast);

  const pending = unsettled(handle.stop().observations);

  assert.deepEqual(pending.map((record) => record.url), [
    "https://api.example.test/slow",
  ]);
  assert.equal(pending[0]?.method, "GET");
  // The caller owns the threshold; the observation only has to make the age computable.
  assert.equal(Date.now() - Date.parse(pending[0]?.at ?? "") >= 0, true);
  await session.close();
});

test("pairs concurrent requests to one endpoint by identity, not by method and url", async () => {
  const { session, page } = await openSession();
  const handle = session.observe();
  const url = "https://api.example.test/auth/token/refresh";
  // The shape of a token-refresh retry: three in-flight attempts, one completes.
  const attempts = [
    requestPayload("POST", url),
    requestPayload("POST", url),
    requestPayload("POST", url),
  ];

  for (const attempt of attempts) page.emit("request", attempt);
  page.emit("requestfinished", attempts[1]);
  page.emit("response", responsePayload(200, url, "POST", attempts[1]));

  const { observations } = handle.stop();
  const started = observations.filter((record) => record.kind === "requestStarted");

  assert.equal(started.length, 3);
  assert.deepEqual(started.map((record) => record.requestId), [1, 2, 3]);
  assert.deepEqual(unsettled(observations).map((record) => record.requestId), [1, 3]);
  // The response reports the id of the attempt that actually produced it.
  assert.equal(
    observations.find((record) => record.kind === "response")?.requestId,
    2,
  );
  // method + url is identical across all three attempts, so the old pairing key marks
  // every start settled as soon as one finishes and loses both hung attempts.
  const byMethodAndUrl = new Set(
    observations
      .filter((record) => record.kind === "requestFinished")
      .map((record) => `${record.method ?? ""} ${record.url ?? ""}`),
  );
  assert.equal(
    started.filter((record) => !byMethodAndUrl.has(`${record.method ?? ""} ${record.url ?? ""}`))
      .length,
    0,
  );
  await session.close();
});
