import assert from "node:assert/strict";
import test from "node:test";

import {
  createOperationId,
  createRunId,
  createTaskId,
  parseOperationId,
  parseRunId,
  parseTaskId,
  parseTestId,
} from "../src/index.js";

test("service test identity has an explicit namespace distinct from UI locator ids", () => {
  assert.equal(parseTestId("service-test:reference/smoke"), "service-test:reference/smoke");
  for (const invalid of [
    "button.submit",
    "reference/smoke",
    "service-test:Reference/smoke",
    "service-test:reference",
    "service-test:reference/smoke/extra",
  ]) {
    assert.throws(() => parseTestId(invalid), /service testId/u);
  }
});

test("operation, run and Planner task identities cannot be interchanged", () => {
  const operationId = createOperationId();
  const runId = createRunId();
  const taskId = createTaskId();

  assert.equal(parseOperationId(operationId), operationId);
  assert.equal(parseRunId(runId), runId);
  assert.equal(parseTaskId(taskId), taskId);
  assert.throws(() => parseRunId(operationId), /runId/u);
  assert.throws(() => parseTaskId(runId), /taskId/u);
  assert.throws(() => parseOperationId(taskId), /operationId/u);
});
