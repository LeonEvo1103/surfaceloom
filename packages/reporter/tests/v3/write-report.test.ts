import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeReportV3Bundle } from "../../src/v3/index.js";
import { v3Input } from "./fixtures.js";

test("the highest ordinal final attempt determines the authoritative Case verdict", async (context) => {
  const root = await temporary(context);
  await assert.rejects(
    writeReportV3Bundle(v3Input("attempt-1"), path.join(root, "stale-final")),
    /highest attempt ordinal/,
  );
  const failedInput = v3Input();
  const attempts = failedInput.tests[0]!.attempts;
  assert.equal(attempts.state, "known");
  if (attempts.state !== "known") return;
  const firstFailure = attempts.items.find((attempt) => attempt.id === "attempt-1")!.result;
  const finalIndex = attempts.items.findIndex((attempt) => attempt.id === "attempt-2");
  (attempts.items as unknown as { result: typeof firstFailure }[])[finalIndex]!.result = firstFailure;
  const failedFinal = await writeReportV3Bundle(failedInput, path.join(root, "failed"));
  assert.equal(failedFinal.report.status, "failed");
  assert.equal(failedFinal.report.summary.failed, 1);
  assert.equal(failedFinal.report.summary.passed, 0);
  assert.equal(failedFinal.report.summary.attempts, 2);

  const passedFinal = await writeReportV3Bundle(v3Input("attempt-2"), path.join(root, "passed"));
  assert.equal(passedFinal.report.status, "passed");
  assert.equal(passedFinal.report.summary.passed, 1);
  assert.equal(passedFinal.report.summary.failed, 0);
});

test("structured evidence keys keep ambiguous Case and attempt ids isolated", async (context) => {
  const root = await temporary(context);
  const leftSource = path.join(root, "left.txt");
  const rightSource = path.join(root, "right.txt");
  await Promise.all([writeFile(leftSource, "left"), writeFile(rightSource, "right")]);
  const input = v3Input();
  const base = input.tests[0]!;
  const makeTest = (caseId: string, attemptId: string, sourcePath: string) => ({
    ...base,
    spec: { ...base.spec, id: caseId },
    attempts: {
      state: "known" as const,
      finalAttemptId: attemptId,
      items: [{
        id: attemptId,
        ordinal: 1,
        executionPlatforms: ["web"] as const,
        runnerHostId: { state: "known" as const, value: "runner" },
        surfaceIds: { state: "known" as const, value: ["page"] },
        result: {
          ...(base.attempts.state === "known" ? base.attempts.items[0]!.result : neverResult()),
          artifacts: [{ id: "log", kind: "log" as const, phase: "after" as const,
            title: "日志", captureStatus: "captured" as const, contentType: "text/plain",
            capturedAt: input.run.startedAt, sourcePath }],
        },
      }],
    },
  });
  const output = await writeReportV3Bundle({ ...input, tests: [
    makeTest("a:b", "c", leftSource), makeTest("a", "b:c", rightSource),
  ] }, path.join(root, "report"), { evidencePolicy: { logs: "always" } });
  const paths = output.report.tests.map((item) => item.attempts.state === "known"
    ? item.attempts.items[0]!.result.artifacts[0]!.relativePath! : "");
  assert.notEqual(paths[0], paths[1]);
  assert.equal(await readFile(path.join(output.directory, paths[0]!), "utf8"), "left");
  assert.equal(await readFile(path.join(output.directory, paths[1]!), "utf8"), "right");
});

test("writes canonical JSON first-class data and deterministic derived views", async (context) => {
  const root = await temporary(context);
  const left = await writeReportV3Bundle(v3Input(), path.join(root, "left"));
  const right = await writeReportV3Bundle(v3Input(), path.join(root, "right"));
  const [leftJSON, rightJSON, leftHTML, rightHTML, leftAI, rightAI] = await Promise.all([
    readFile(left.reportPath, "utf8"), readFile(right.reportPath, "utf8"),
    readFile(left.htmlPath, "utf8"), readFile(right.htmlPath, "utf8"),
    readFile(left.aiReviewPath, "utf8"), readFile(right.aiReviewPath, "utf8"),
  ]);
  assert.equal(leftJSON, rightJSON);
  assert.equal(leftHTML, rightHTML);
  assert.equal(leftAI, rightAI);
  assert.match(leftJSON, /surfaceloom\.report\/v3/);
  assert.match(leftJSON, /"runnerHostId"/);
  assert.match(leftHTML, /report\.json 是权威事实源/);
  assert.match(leftAI, /unknown.*不能推断为单 host、单 surface 或第 1 次 attempt/);
  const completion = JSON.parse(await readFile(left.completionMarkerPath, "utf8")) as {
    reportSha256: string;
  };
  assert.equal(completion.reportSha256,
    createHash("sha256").update(leftJSON).digest("hex"));
});

async function temporary(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "surfaceloom-report-v3-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function neverResult(): never {
  throw new Error("Expected known attempts.");
}
