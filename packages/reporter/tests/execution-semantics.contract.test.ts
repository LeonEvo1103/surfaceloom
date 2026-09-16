import assert from "node:assert/strict";
import test from "node:test";

import { validateReportInput } from "../src/index.js";
import { stubTest } from "./report-contract-fixtures.js";

test("requires the v2 CaseSpec/result split and explicit execution semantics", () => {
  const base = {
    run: {
      id: "run",
      title: "Run",
      platform: "macos" as const,
      startedAt: "2026-08-19T01:00:00.000Z",
      finishedAt: "2026-08-19T01:00:01.000Z",
      app: { id: "fixture", name: "Fixture" },
    },
    tests: [stubTest("passed")],
  };
  const { intent: _intent, ...specWithoutIntent } = stubTest("passed").spec;
  assert.throws(
    () => validateReportInput({
      ...base,
      tests: [{ ...stubTest("passed"), spec: specWithoutIntent }],
    } as never),
    /spec\.intent is required/,
  );

  const skipped = stubTest("skipped");
  const { reason: _reason, ...skippedWithoutReason } = skipped.result;
  assert.throws(
    () => validateReportInput({
      ...base,
      tests: [{ ...skipped, result: skippedWithoutReason }],
    } as never),
    /must include a reason for status skipped/,
  );

  const passed = stubTest("passed");
  assert.throws(
    () => validateReportInput({
      ...base,
      tests: [{
        ...passed,
        result: {
          ...passed.result,
          steps: [{
            id: "assert",
            title: "验证不存在的验收项",
            status: "passed",
            durationMs: 1,
            criterionIds: ["missing-criterion"],
          }],
        },
      }],
    }),
    /references unknown criterion/,
  );
  assert.throws(
    () => validateReportInput({
      ...base,
      tests: [{
        ...passed,
        result: {
          ...passed.result,
          steps: [{
            id: "unmapped-assertion",
            title: "执行未映射的断言",
            status: "passed",
            durationMs: 1,
          }],
        },
      }],
    }),
    /does not cover acceptance criteria: result-explicit/,
  );
  assert.throws(
    () => validateReportInput({
      ...base,
      tests: [{
        ...skipped,
        result: { ...skipped.result, reason: "Not available" },
      }],
    }),
    /must include a Chinese reason/,
  );
});
