import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { artifactId, finalAttempt, png, run } from "./runner-v3-final-screenshot-fixture.js";

test("failed Case captures one sensitive PNG before close without changing the verdict",
  async (context) => {
    const reference = await run(context, { capture: "omit", body: "fail" });
    const fixture = await run(context, { body: "fail" });
    assert.deepEqual(fixture.events, ["launch", "screenshot", "close"]);
    assert.equal(fixture.result.exitCode, 1);
    assert.equal(fixture.result.failureOrigin, reference.result.failureOrigin);
    assert.equal(fixture.result.cleanup.status, "passed");
    const attempt = finalAttempt(fixture.result);
    assert.equal(attempt.status, "failed");
    assert.equal(attempt.error?.message, finalAttempt(reference.result).error?.message);
    const shot = attempt.artifacts.find((item) => item.id === artifactId);
    assert.ok(shot);
    assert.equal(shot.captureStatus, "captured");
    assert.equal(shot.phase, "failure");
    assert.equal(shot.kind, "screenshot");
    assert.equal(shot.sensitive, true);
    assert.equal(shot.contentTrust, "untrusted");
    assert.equal(shot.title, "Failure screenshot: page");
    assert.ok(!Number.isNaN(Date.parse(shot.capturedAt)));
    const bytes = await readFile(path.join(fixture.result.bundle.directory, shot.relativePath!));
    assert.deepEqual(new Uint8Array(bytes), png);
    assert.equal(shot.sizeBytes, png.byteLength);
    assert.equal(shot.sha256, createHash("sha256").update(png).digest("hex"));
  });

test("passing Case is not captured under on-failure but is captured under always", async (context) => {
  const onFailure = await run(context, { body: "pass" });
  assert.deepEqual(onFailure.events, ["launch", "close"]);
  assert.equal(finalAttempt(onFailure.result).artifacts.some((item) => item.id === artifactId), false);

  const always = await run(context, { body: "pass", policy: { screenshots: "always" } });
  assert.equal(always.result.exitCode, 0);
  assert.deepEqual(always.events, ["launch", "screenshot", "close"]);
  const shot = finalAttempt(always.result).artifacts.find((item) => item.id === artifactId);
  assert.equal(shot?.captureStatus, "captured");
  assert.equal(shot?.phase, "after");
  assert.equal(shot?.title, "Final screenshot: page");
});

test("screenshots off never calls the port, even for a failed Case", async (context) => {
  const fixture = await run(context, { body: "fail", policy: { screenshots: "off" } });
  assert.deepEqual(fixture.events, ["launch", "close"]);
  assert.equal(finalAttempt(fixture.result).status, "failed");
  assert.equal(finalAttempt(fixture.result).artifacts.some((item) => item.id === artifactId), false);
});

test("a backend without captureScreenshot is reported as unsupported", async (context) => {
  const fixture = await run(context, { body: "fail", capture: "omit" });
  const shot = finalAttempt(fixture.result).artifacts.find((item) => item.id === artifactId);
  assert.equal(shot?.captureStatus, "unsupported");
  assert.match(shot?.captureError ?? "", /does not implement captureScreenshot/u);
  assert.equal(finalAttempt(fixture.result).status, "failed");
});

test("crashed or closed browser rejection is recorded as captureFailed and close still runs",
  async (context) => {
    const fixture = await run(context, { body: "fail", capture: async () => {
      throw new Error("Target page, context or browser has been closed");
    } });
    assert.deepEqual(fixture.events, ["launch", "close"]);
    assert.equal(fixture.result.cleanup.status, "passed");
    const attempt = finalAttempt(fixture.result);
    assert.equal(attempt.status, "failed");
    assert.match(attempt.error?.message ?? "", /business assertion failed/u);
    const shot = attempt.artifacts.find((item) => item.id === artifactId);
    assert.equal(shot?.captureStatus, "captureFailed");
    assert.match(shot?.captureError ?? "", /has been closed/u);
  });

test("a hung screenshot is bounded by half the cleanup window and close still confirms",
  async (context) => {
    let aborted = false;
    const started = performance.now();
    const fixture = await run(context, { body: "fail", cleanupTimeoutMs: 400,
      capture: (call) => new Promise((_resolve, reject) => {
        call.signal.addEventListener("abort", () => { aborted = true; reject(new Error("late")); });
      }) });
    const elapsed = performance.now() - started;
    assert.equal(aborted, true);
    assert.deepEqual(fixture.events, ["launch", "close"]);
    assert.equal(fixture.result.cleanup.status, "passed");
    assert.ok(elapsed < 1_500, `capture was not bounded: ${elapsed} ms`);
    const shot = finalAttempt(fixture.result).artifacts.find((item) => item.id === artifactId);
    assert.equal(shot?.captureStatus, "captureFailed");
    assert.match(shot?.captureError ?? "", /did not complete within (1\d\d|200) ms/u);
  });

test("non-PNG bytes are rejected by the shared image evidence validator", async (context) => {
  const fixture = await run(context, { body: "fail", capture: async () => ({
    mediaType: "image/png", bytes: Uint8Array.from([1, 2, 3]) }) });
  const shot = finalAttempt(fixture.result).artifacts.find((item) => item.id === artifactId);
  assert.equal(shot?.captureStatus, "captureFailed");
  assert.match(shot?.captureError ?? "", /rejected as attempt evidence/u);
  assert.equal(finalAttempt(fixture.result).status, "failed");
});

test("timed-out Case records why no screenshot fit in the expired cleanup window", async (context) => {
  const fixture = await run(context, { body: "hangUntilAbort", timeoutMs: 150 });
  const attempt = finalAttempt(fixture.result);
  assert.equal(attempt.status, "timedOut");
  assert.equal(fixture.result.failureOrigin, "infrastructure");
  assert.equal(fixture.events.includes("screenshot"), false);
  const shot = attempt.artifacts.find((item) => item.id === artifactId);
  assert.equal(shot?.captureStatus, "captureFailed");
  assert.match(shot?.captureError ?? "", /Cleanup (stopped|deadline expired) before the browser screenshot/u);
});

test("failure found only after cleanup started is reported as notRequested, not invented",
  async (context) => {
    const fixture = await run(context, { body: "skipCriterion" });
    const attempt = finalAttempt(fixture.result);
    assert.equal(attempt.status, "failed");
    assert.deepEqual(fixture.events, ["launch", "close"]);
    const shot = attempt.artifacts.find((item) => item.id === artifactId);
    assert.equal(shot?.captureStatus, "notRequested");
    assert.match(shot?.description ?? "", /not visible to the runner when/u);
  });
