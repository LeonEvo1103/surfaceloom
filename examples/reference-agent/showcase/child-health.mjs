export function assertChildInfrastructureHealthy(result, canonical, spec) {
  const report = result?.bundle?.report;
  const attempts = report?.tests?.length === 1 ? report.tests[0].attempts : undefined;
  const attempt = attempts?.state === "known"
    ? attempts.items.find((item) => item.id === attempts.finalAttemptId) : undefined;
  if (!attempt || attempt.id !== "attempt-1") {
    throw new Error(`Child ${canonical.id} has no final execution attempt.`);
  }
  const execution = exactlyOne(attempt.result.steps, "kernel.execution", canonical.id);
  const cleanup = exactlyOne(attempt.result.steps, "kernel.cleanup", canonical.id);
  assertExecutionDiagnostic(execution, canonical.id);
  assertCleanupDiagnostic(cleanup, canonical.id);
  assertBusinessFailuresOnly(attempt.result, canonical, spec);
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

function empty(value) { return Array.isArray(value) && value.length === 0; }
function unhealthy(caseId, reason) {
  return new Error(`Child ${caseId} infrastructure is unhealthy: ${reason}.`);
}
