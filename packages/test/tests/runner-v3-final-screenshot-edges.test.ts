import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { artifactId, finalAttempt, png, run, type CaseBody } from "./runner-v3-final-screenshot-fixture.js";

const authorPng = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

const verify = (fail: boolean): CaseBody => async (context) => {
  await context.criterion("verified", () => {
    if (fail) throw new Error("business assertion failed");
  });
};

test("a Case image that already uses the runner screenshot id keeps it; the Case still passes",
  async (context) => {
    const fixture = await run(context, { policy: { screenshots: "always" }, body: async (caseContext) => {
      caseContext.evidence.submitImage({ id: artifactId, artifactId, mediaType: "image/png",
        bytes: authorPng });
      await verify(false)(caseContext);
    } });
    assert.equal(fixture.result.exitCode, 0);
    const attempt = finalAttempt(fixture.result);
    assert.equal(attempt.status, "passed");
    const authored = attempt.artifacts.find((item) => item.id === artifactId);
    assert.equal(authored?.title, "Judge image evidence");
    const bundle = fixture.result.bundle.directory;
    assert.deepEqual(new Uint8Array(await readFile(path.join(bundle, authored!.relativePath!))), authorPng);
    const runner = attempt.artifacts.find((item) => item.id === `${artifactId}.2`);
    assert.equal(runner?.captureStatus, "captured");
    assert.equal(runner?.title, "Final screenshot: page");
    assert.deepEqual(new Uint8Array(await readFile(path.join(bundle, runner!.relativePath!))), png);
  });

test("a Case text evidence id equal to the runner screenshot id does not break a failed report",
  async (context) => {
    const body: CaseBody = async (caseContext) => {
      caseContext.evidence.submit({ id: "author-probe", artifactId, content: { kind: "probe",
        probeId: "author-probe", resource: "case.result", outcome: "observed", value: { ok: false } } });
      await verify(true)(caseContext);
    };
    const reference = await run(context, { body, capture: "omit", policy: { screenshots: "off" } });
    const fixture = await run(context, { body, capture: "omit" });
    assert.equal(fixture.result.exitCode, 1);
    assert.equal(fixture.result.failureOrigin, reference.result.failureOrigin);
    const attempt = finalAttempt(fixture.result);
    assert.equal(attempt.status, "failed");
    assert.equal(attempt.error?.message, finalAttempt(reference.result).error?.message);
    assert.equal(attempt.artifacts.filter((item) => item.id === artifactId).length, 1);
    assert.equal(attempt.artifacts.find((item) => item.id === `${artifactId}.2`)?.captureStatus,
      "unsupported");
  });

test("Case images that use up the shared byte budget turn the screenshot into captureFailed only",
  async (context) => {
    const big = new Uint8Array(5 * 1024 * 1024);
    big.set(png.subarray(0, 8));
    const body = (fail: boolean): CaseBody => async (caseContext) => {
      for (const id of ["author-a", "author-b"]) {
        caseContext.evidence.submitImage({ id, artifactId: id, mediaType: "image/png", bytes: big });
      }
      await verify(fail)(caseContext);
    };
    const reference = await run(context, { body: body(true), policy: { screenshots: "off" } });
    const failed = await run(context, { body: body(true) });
    assert.equal(failed.result.exitCode, 1);
    assert.equal(failed.result.failureOrigin, reference.result.failureOrigin);
    assert.equal(finalAttempt(failed.result).error?.message, finalAttempt(reference.result).error?.message);
    const shot = finalAttempt(failed.result).artifacts.find((item) => item.id === artifactId);
    assert.equal(shot?.captureStatus, "captureFailed");
    assert.match(shot?.captureError ?? "", /total byte budget/u);

    const passed = await run(context, { body: body(false), policy: { screenshots: "always" } });
    assert.equal(passed.result.exitCode, 0);
    assert.equal(finalAttempt(passed.result).status, "passed");
    assert.equal(finalAttempt(passed.result).artifacts.find((item) => item.id === artifactId)
      ?.captureStatus, "captureFailed");
  });

test("a step failure caught by Case code still fails the Case and is captured", async (context) => {
  const fixture = await run(context, { body: async (caseContext) => {
    await caseContext.step({ id: "flaky", title: "Caught step" }, () => {
      throw new Error("caught step failure");
    }).catch(() => undefined);
    await verify(false)(caseContext);
  } });
  assert.equal(fixture.result.exitCode, 1);
  assert.equal(finalAttempt(fixture.result).status, "failed");
  assert.deepEqual(fixture.events, ["launch", "screenshot", "close"]);
  const shot = finalAttempt(fixture.result).artifacts.find((item) => item.id === artifactId);
  assert.equal(shot?.captureStatus, "captured");
  assert.equal(shot?.phase, "failure");
});

test("each browser surface is captured before its own close, and none are on a pass",
  async (context) => {
    const surfaceIds = ["alpha", "beta"];
    const failed = await run(context, { surfaceIds, body: verify(true) });
    assert.deepEqual(failed.events, ["launch:alpha", "launch:beta",
      "screenshot:beta", "close:beta", "screenshot:alpha", "close:alpha"]);
    const artifacts = finalAttempt(failed.result).artifacts;
    for (const surfaceId of surfaceIds) {
      const shot = artifacts.find((item) => item.id === `surfaceloom.screenshot.${surfaceId}`);
      assert.equal(shot?.captureStatus, "captured");
      assert.equal(shot?.title, `Failure screenshot: ${surfaceId}`);
    }

    const passed = await run(context, { surfaceIds, body: verify(false) });
    assert.equal(passed.result.exitCode, 0);
    assert.deepEqual(passed.events, ["launch:alpha", "launch:beta", "close:beta", "close:alpha"]);
    assert.equal(finalAttempt(passed.result).artifacts.some((item) =>
      item.id.startsWith("surfaceloom.screenshot.")), false);
  });
