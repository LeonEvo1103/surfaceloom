import assert from "node:assert/strict";
import test from "node:test";

import { executeCase } from "../../../../packages/test/dist/index.js";
import { resolveBrowserLaunchOptions } from "../../adapter/browser-launch.mjs";
import {
  approveSpec,
  createApprovalCase,
  createDenialCase,
  denySpec,
  executionOptions,
} from "../../cases/approval-cases.mjs";

const browserLaunchOptions = await resolveBrowserLaunchOptions();

test("真实浏览器拒绝审批，完整账本证明执行次数为零", async () => {
  const report = await executeCase(
    createDenialCase({ browserLaunchOptions }),
    executionOptions(denySpec),
  );
  assert.equal(report.result.status, "passed", diagnostic(report));
  assertCriterion(report, "deny-status", "passed");
  assertCriterion(report, "deny-zero-executions", "passed");
});

test("真实浏览器批准审批，账本与实际副作用均恰好一次", async () => {
  const report = await executeCase(
    createApprovalCase({ browserLaunchOptions }),
    executionOptions(approveSpec),
  );
  assert.equal(report.result.status, "passed", diagnostic(report));
  assertCriterion(report, "approve-status", "passed");
  assertCriterion(report, "approve-one-execution", "passed");
  assertCriterion(report, "approve-one-effect", "passed");
});

test("真实浏览器拒绝后若工具仍执行，同一零调用 Case 必须失败", async () => {
  const report = await executeCase(
    createDenialCase({ browserLaunchOptions, fault: "deny-but-execute" }),
    executionOptions(denySpec),
  );
  assert.equal(report.result.status, "failed");
  assertCriterion(report, "deny-status", "passed");
  const failed = assertCriterion(report, "deny-zero-executions", "failed");
  assert.match(failed.diagnostic ?? "", /Observation assertion timedOut/);
  assert.match(failed.diagnostic ?? "", /"started":1/);
  assert.match(failed.diagnostic ?? "", /"completed":1/);
});

test("真实浏览器拒绝后若账本不完整，不能把未知状态判成零调用", async () => {
  const report = await executeCase(
    createDenialCase({ browserLaunchOptions, fault: "incomplete-ledger" }),
    executionOptions(denySpec),
  );
  assert.equal(report.result.status, "failed");
  assertCriterion(report, "deny-status", "passed");
  const failed = assertCriterion(report, "deny-zero-executions", "failed");
  assert.match(failed.diagnostic ?? "", /Observation assertion timedOut/);
  assert.match(failed.diagnostic ?? "", /unknown/);
});

function assertCriterion(report, criterionId, expectedStatus) {
  const step = report.result.steps.find((candidate) => candidate.criterionIds?.includes(criterionId));
  assert.ok(step, `Missing criterion step ${criterionId}. ${diagnostic(report)}`);
  assert.equal(step.status, expectedStatus, step.diagnostic);
  return step;
}

function diagnostic(report) {
  return report.result.steps.map((step) => step.diagnostic).filter(Boolean).join("\n");
}
