import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultEvidencePolicy,
  overallStatus,
  retainEvidence,
  summarizeTests,
  validateEvidencePolicy,
  validateReportInput,
} from "../src/index.js";
import {
  screenshot,
  screenshotWithoutSource,
  stubTest,
} from "./report-contract-fixtures.js";

test("retain-on-failure keeps failed media and drops passed media", () => {
  assert.equal(retainEvidence(screenshot, "failed", defaultEvidencePolicy), true);
  assert.equal(retainEvidence(screenshot, "passed", defaultEvidencePolicy), false);
  assert.equal(retainEvidence({ ...screenshotWithoutSource, captureStatus: "unsupported" }, "passed", defaultEvidencePolicy), true);
  assert.equal(retainEvidence({ ...screenshot, kind: "trace", contentType: "application/json" }, "passed", defaultEvidencePolicy), true);
  assert.equal(retainEvidence({ ...screenshot, kind: "agentLoop", contentType: "text/html" }, "passed", defaultEvidencePolicy), true);
});

test("summary never counts skipped tests as passed or executed", () => {
  const summary = summarizeTests([
    stubTest("passed"),
    stubTest("skipped"),
    stubTest("unsupported"),
  ]);
  assert.deepEqual(summary, {
    discovered: 3,
    executed: 2,
    passed: 1,
    failed: 0,
    timedOut: 0,
    skipped: 1,
    unsupported: 1,
    evidence: { captured: 0, captureFailed: 0, unsupported: 0, notRequested: 0 },
  });
  assert.equal(overallStatus(summary), "incomplete");
});

test("validates capture state, content type, and evidence policy", () => {
  const input = {
    run: {
      id: "run",
      title: "Run",
      platform: "windows" as const,
      startedAt: "2026-08-19T01:00:00.000Z",
      finishedAt: "2026-08-19T01:00:01.000Z",
      app: { id: "fixture", name: "Fixture" },
    },
    tests: [{
      ...stubTest("passed"),
      result: { ...stubTest("passed").result, artifacts: [screenshot] },
    }],
  };
  assert.doesNotThrow(() => validateReportInput(input));
  assert.doesNotThrow(() => validateReportInput({
    ...input,
    tests: [{
      ...stubTest("passed"),
      result: {
        ...stubTest("passed").result,
        artifacts: [{ ...screenshot, kind: "agentLoop", contentType: "text/html" }],
      },
    }],
  }));
  assert.throws(
    () => validateReportInput({
      ...input,
      tests: [{
        ...stubTest("passed"),
        result: {
          ...stubTest("passed").result,
          artifacts: [{
            ...screenshotWithoutSource,
            captureStatus: "captureFailed" as const,
          }],
        },
      }],
    }),
    /explain why capture failed/,
  );
  assert.throws(
    () => validateEvidencePolicy({ ...defaultEvidencePolicy, video: "sometimes" as never }),
    /Unknown evidence retention/,
  );
  assert.throws(
    () => validateEvidencePolicy({
      ...defaultEvidencePolicy,
      screenshot: "off",
    } as never),
    /keys must be exactly/,
  );
  assert.throws(
    () => validateReportInput({
      ...input,
      tests: [{
        ...stubTest("passed"),
        result: {
          ...stubTest("passed").result,
          artifacts: [{ ...screenshot, reviewPriority: "tertiary" as never }],
        },
      }],
    }),
    /Unknown artifact review priority/,
  );
  assert.throws(
    () => validateReportInput({
      ...input,
      tests: [{
        ...stubTest("passed"),
        result: {
          ...stubTest("passed").result,
          artifacts: [{ ...screenshot, kind: "__proto__" as never }],
        },
      }],
    }),
    /Unknown artifact kind/,
  );
});
