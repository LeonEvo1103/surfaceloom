import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveBrowserLaunchOptions } from "../../adapter/browser-launch.mjs";
import { runShowcase } from "../../showcase/run.mjs";

test("one command runs four real Playwright v3 Agent Cases into one honest bundle", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sl-showcase-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "result");
  const result = await runShowcase({ outputRoot: output,
    launchOptions: await resolveBrowserLaunchOptions() });
  assert.equal(result.exitCode, 1);
  assert.equal(result.bundle.report.status, "failed");
  assert.deepEqual({ discovered: result.bundle.report.summary.discovered,
    passed: result.bundle.report.summary.passed, failed: result.bundle.report.summary.failed,
    skipped: result.bundle.report.summary.skipped },
  { discovered: 4, passed: 2, failed: 2, skipped: 0 });
  assert.equal(result.bundle.report.tests.length, 4);
  assert.ok(result.bundle.report.tests.every((item) => item.attempts.state === "known"
    && item.attempts.items[0].result.artifacts.length > 0));
  await stat(result.bundle.htmlPath);
  await stat(result.bundle.aiReviewPath);
  const completion = JSON.parse(await readFile(result.bundle.completionMarkerPath, "utf8"));
  assert.equal(completion.report, "report.json");
  assert.ok(result.cleanupReceipts.length >= 5);
});
