export function assertChildInfrastructureHealthy(result, canonical, spec) {
  const attempt = finalAttempt(result, canonical.id);
  const execution = exactlyOne(attempt.result.steps, "kernel.execution", canonical.id);
  const cleanup = exactlyOne(attempt.result.steps, "kernel.cleanup", canonical.id);
  assertExecutionDiagnostic(execution, canonical.id);
  assertCleanupDiagnostic(cleanup, canonical.id);
  assertBusinessFailuresOnly(attempt.result, canonical, spec);
}

export function assertExpectedResourceCleanupFailure(result, canonical, spec,
  expectedResourcePrefix) {
  const attempt = finalAttempt(result, canonical.id);
  const execution = exactlyOne(attempt.result.steps, "kernel.execution", canonical.id);
  assertExecutionDiagnostic(execution, canonical.id);
  if (attempt.result.steps.some((step) => step.id === "kernel.cleanup")) {
    throw unhealthy(canonical.id, "unexpected successful cleanup diagnostic is present");
  }
  const criteria = new Map();
  for (const step of attempt.result.steps) {
    for (const id of step.criterionIds ?? []) criteria.set(id, step.status);
  }
  if (spec.acceptanceCriteria.some((criterion) => criteria.get(criterion.id) !== "passed")) {
    throw unhealthy(canonical.id, "a business criterion failed before expected cleanup failure");
  }
  const failed = attempt.result.steps.filter((step) => step.status === "failed");
  if (attempt.result.error?.category !== "fixtureTeardown" || failed.length === 0
      || failed.some((step) => !/^kernel\.fixtureTeardown\.\d+$/u.test(step.id))) {
    throw unhealthy(canonical.id, "failure was not limited to fixtureTeardown cleanup diagnostics");
  }
  for (const step of failed) {
    const details = errorDiagnostic(step, canonical.id)?.details;
    if (details?.kind !== "resourceCleanup") {
      throw unhealthy(canonical.id, "fixtureTeardown failure was not resourceCleanup");
    }
    assertExpectedCleanupData(details.data, canonical.id, expectedResourcePrefix);
  }
}

function finalAttempt(result, caseId) {
  const report = result?.bundle?.report;
  const attempts = report?.tests?.length === 1 ? report.tests[0].attempts : undefined;
  const attempt = attempts?.state === "known"
    ? attempts.items.find((item) => item.id === attempts.finalAttemptId) : undefined;
  if (!attempt || attempt.id !== "attempt-1") {
    throw new Error(`Child ${caseId} has no final execution attempt.`);
  }
  return attempt;
}

function exactlyOne(steps, id, caseId) {
  const matches = Array.isArray(steps) ? steps.filter((step) => step.id === id) : [];
  if (matches.length !== 1) throw unhealthy(caseId, `${id} is missing or ambiguous`);
  return matches[0];
}

function assertExecutionDiagnostic(step, caseId) {
  const worker = diagnostic(step, caseId)?.data?.worker;
  if (step.status !== "passed" || worker?.state !== "settled" || worker.tainted !== false
      || worker.cancellationRequested !== false || worker.settlement?.status !== "fulfilled"
      || !empty(worker.failures)) {
    throw unhealthy(caseId, "execution producer did not settle cleanly");
  }
}

function assertCleanupDiagnostic(step, caseId) {
  const cleanup = diagnostic(step, caseId)?.data?.cleanup;
  if (step.status !== "passed" || cleanup?.state !== "closed" || cleanup.status !== "passed"
      || cleanup.tainted !== false || !empty(cleanup.remaining) || !empty(cleanup.failures)
      || !Array.isArray(cleanup.outcomes)
      || cleanup.outcomes.some((item) => !["released", "borrowed"].includes(item?.status))) {
    throw unhealthy(caseId, "resource cleanup is failed, tainted, or unconfirmed");
  }
}

function assertBusinessFailuresOnly(result, canonical, spec) {
  const failed = result.steps.filter((step) => step.status === "failed");
  if (canonical.expectedStatus === "passed") {
    if (failed.length > 0 || result.error !== undefined) {
      throw unhealthy(canonical.id, "a passing Case contains a failed execution step");
    }
    return;
  }
  const acceptanceIds = new Set(spec.acceptanceCriteria.map((item) => item.id));
  const failedCriteria = failed.filter((step) => /^kernel\.criterion\.\d+$/u.test(step.id));
  const allowed = failed.every((step) => {
    if (/^kernel\.criterion\.\d+$/u.test(step.id)) {
      return Array.isArray(step.criterionIds) && step.criterionIds.length > 0
        && step.criterionIds.every((id) => acceptanceIds.has(id));
    }
    return /^kernel\.body\.\d+$/u.test(step.id);
  });
  if (result.error?.category !== "criterion" || failedCriteria.length === 0 || !allowed) {
    throw unhealthy(canonical.id, "the red verdict was not caused only by acceptance criteria");
  }
}

function diagnostic(step, caseId) {
  if (typeof step.diagnostic !== "string") throw unhealthy(caseId, `${step.id} has no diagnostic`);
  let value;
  try { value = JSON.parse(step.diagnostic); }
  catch { throw unhealthy(caseId, `${step.id} diagnostic is invalid`); }
  if (value?.schemaVersion !== "surfaceloom.execution-diagnostic/v1") {
    throw unhealthy(caseId, `${step.id} diagnostic schema is unknown`);
  }
  return value;
}

function errorDiagnostic(step, caseId) {
  if (typeof step.diagnostic !== "string") throw unhealthy(caseId, `${step.id} has no diagnostic`);
  let value;
  try { value = JSON.parse(step.diagnostic); }
  catch { throw unhealthy(caseId, `${step.id} diagnostic is invalid`); }
  if (value?.details?.schemaVersion !== "surfaceloom.error-diagnostic/v1") {
    throw unhealthy(caseId, `${step.id} error diagnostic schema is unknown`);
  }
  return value;
}

function assertExpectedCleanupData(cleanup, caseId, expectedResourcePrefix) {
  if (cleanup?.state !== "closed" || cleanup.status !== "failed" || cleanup.tainted !== true
      || !empty(cleanup.remaining) || !Array.isArray(cleanup.outcomes)
      || !Array.isArray(cleanup.failures)) {
    throw unhealthy(caseId, "expected cleanup result is not closed and tainted");
  }
  const expected = cleanup.outcomes.filter((item) =>
    typeof item?.id === "string" && item.id.startsWith(expectedResourcePrefix));
  if (expected.length !== 1 || expected[0].status !== "unconfirmed"
      || expected[0].failure?.code !== "cleanupUnconfirmed"
      || expected[0].failure?.message !== "Run work did not settle before cleanup deadline.") {
    throw unhealthy(caseId, "owned run-work unconfirmed receipt is missing or ambiguous");
  }
  const allowed = cleanup.outcomes.every((item) => {
    if (item === expected[0]) return true;
    if (item?.id === "surface.browser.session.approval-ui") {
      return item.status === "unconfirmed" && item.failure?.code === "cleanupUnconfirmed"
        && item.failure?.message === "Browser cleanup stopped: cleanup deadline expired";
    }
    if (item?.id === "kernel.fixture.test") {
      return item.status === "failed" && item.failure?.code === "cleanupFailed"
        && item.failure?.message === "Reference agent work did not confirm settlement before close.";
    }
    return item?.id === "kernel.fixture.worker" && item.status === "released";
  });
  const failureIds = cleanup.outcomes.filter((item) =>
    item.status === "failed" || item.status === "unconfirmed").map((item) => item.id).sort();
  const recordedIds = cleanup.failures.map((failure) => failure.resourceId).sort();
  if (!allowed || cleanup.outcomes.length !== 4 || failureIds.length !== cleanup.failures.length
      || JSON.stringify(failureIds) !== JSON.stringify(recordedIds)
      || cleanup.primaryFailure?.resourceId !== expected[0].id) {
    throw unhealthy(caseId, "cleanup contains an unrelated or unrecorded failure");
  }
}

function empty(value) { return Array.isArray(value) && value.length === 0; }
function unhealthy(caseId, reason) {
  return new Error(`Child ${caseId} infrastructure is unhealthy: ${reason}.`);
}
