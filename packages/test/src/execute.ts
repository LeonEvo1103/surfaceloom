import { FixtureRuntime, type FixtureDefinition } from "@surfaceloom/core";
import { validateReportInput, type NormalizedCaseReportInput, type TestStepResult } from "@surfaceloom/reporter";
import type { CaseContext, CaseDefinition, CaseStep, ExecuteCaseOptions } from "./contracts.js";
import { startDeadlineTask } from "./deadline.js";
import { defineCase } from "./definition.js";
import {
  absentCleanupStep, cleanupFailureError, cleanupStep, lifecycleError, passedLifecycleStep,
} from "./execution-diagnostics.js";
import { ExecutionDispatchDrain } from "./execution-dispatch.js";
import { prepareExecution } from "./execution-options.js";
import type { EffectDescriptor } from "./effects.js";
import { elapsed, ExecutionRecorder } from "./recorder.js";
import { ResourceScope } from "./resources.js";
import type { ResourceCleanupResult } from "./resources-contracts.js";
import type { ResourceCleanupBoundary, ResourceRegistration } from "./resources-contracts.js";
import { trackInProcessTask } from "./worker.js";
import type { WorkerStopSnapshot } from "./worker-contracts.js";

/** Execute a Case through one preflighted, deadline-bound lifecycle producer. */
export async function executeCase(
  input: CaseDefinition,
  options: ExecuteCaseOptions,
): Promise<NormalizedCaseReportInput> {
  return (await executeCaseKernel(input, options)).report;
}

export interface RunnerCaseInternals {
  readonly cleanupBoundary: ResourceCleanupBoundary;
  cleanupSnapshot(): ResourceCleanupResult;
}

export interface RunnerCaseExecutionResult {
  readonly report: NormalizedCaseReportInput;
  readonly cleanup: ResourceCleanupResult | RunnerCleanupNotStarted;
  readonly worker: WorkerStopSnapshot;
  /** True only after the producer settled and cleanup reached a terminal snapshot. */
  readonly publicationReady: boolean;
}

export interface RunnerCleanupNotStarted {
  readonly state: "notStarted";
  readonly status: "notStarted";
}

/** Internal v3 seam. It is intentionally not exported from the package author barrel. */
export async function executeCaseWithRunnerContext(
  input: CaseDefinition,
  options: ExecuteCaseOptions,
  runnerBody: (context: CaseContext, internals: RunnerCaseInternals) => void | Promise<void>,
): Promise<RunnerCaseExecutionResult> {
  const result = await executeCaseKernel(input, options, runnerBody);
  const cleanup = result.cleanup ?? Object.freeze({ state: "notStarted" as const,
    status: "notStarted" as const });
  const producerSettled = result.worker.state === "settled"
    || result.worker.state === "cooperativeStopped";
  return Object.freeze({ report: result.report, cleanup, worker: result.worker,
    publicationReady: producerSettled && cleanup.state === "closed" });
}

interface KernelExecutionResult {
  readonly report: NormalizedCaseReportInput;
  readonly cleanup?: ResourceCleanupResult;
  readonly worker: WorkerStopSnapshot;
}

async function executeCaseKernel(
  input: CaseDefinition,
  options: ExecuteCaseOptions,
  runnerBody?: (context: CaseContext, internals: RunnerCaseInternals) => void | Promise<void>,
): Promise<KernelExecutionResult> {
  const definition = defineCase(input);
  const selectedPlatform = options.platform;
  if (!definition.spec.platforms.includes(selectedPlatform)) {
    throw new Error(`Case ${definition.spec.id} does not support platform ${selectedPlatform}.`);
  }
  const execution = prepareExecution(definition.spec, options, selectedPlatform);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const recorder = new ExecutionRecorder(definition.spec);
  const dispatches = new ExecutionDispatchDrain(recorder);
  const cleanupErrors = new Map<string, unknown>();
  let resourceScope: ResourceScope | undefined;
  let cleanupResult: ResourceCleanupResult | undefined;
  let accepting = false;
  const task = startDeadlineTask(async (deadline) => {
    const resources = new ResourceScope({ cleanupTimeoutMs: execution.cleanupTimeoutMs,
      cleanupDeadlineAt: performance.now() + deadline.remainingMs() });
    resourceScope = resources;
    const workerFixtures = new FixtureRuntime("worker");
    const testFixtures = workerFixtures.createTestScope();
    registerFixtureRuntimes(resources, testFixtures, workerFixtures, cleanupErrors);
    const values = new Map<FixtureDefinition<unknown>, unknown>();
    const assertActive = () => {
      if (!accepting) throw new Error("Case execution is no longer accepting work.");
      recorder.assertOpen();
    };
    const context: CaseContext = Object.freeze({
      signal: deadline.signal,
      remainingMs: () => { assertActive(); return deadline.remainingMs(); },
      throwIfCancelled: () => { assertActive(); deadline.throwIfCancelled(); },
      acknowledgeCancellation: () => { assertActive(); return deadline.acknowledgeCancellation(); },
      fixture: <T>(fixture: FixtureDefinition<T>): T => {
        assertActive();
        if (!values.has(fixture)) throw new Error(`Fixture ${fixture.id} is not a declared case fixture.`);
        return values.get(fixture) as T;
      },
      step: <T>(step: CaseStep, body: () => T | Promise<T>) => {
        assertActive(); return recorder.step(step, body);
      },
      criterion: <T>(id: string, check: () => T | Promise<T>) => {
        assertActive(); return recorder.criterion(id, check);
      },
      registerResource: (resource: ResourceRegistration) => {
        if (accepting) { recorder.assertOpen(); resources.register(resource); return; }
        // During cleanup, let ResourceScope retain a sticky scopeClosed failure even
        // when a provider catches the thrown error. An unconfirmed producer leaves
        // the scope open; late Case code must not add resources after publication.
        if (resources.snapshot().state !== "open") { resources.register(resource); return; }
        throw new Error("Case execution is no longer accepting work.");
      },
      dispatch: <T>(effect: EffectDescriptor,
        action: (authorized: Readonly<EffectDescriptor>) => T | Promise<T>) => {
        assertActive(); return dispatches.dispatch(execution.gate, effect, action);
      },
    });
    accepting = true;
    let phase = "fixtureSetup";
    try {
      for (const fixture of definition.fixtures ?? []) {
        deadline.throwIfCancelled();
        const value = await recorder.stage(phase, `Setup fixture: ${fixture.id}`,
          () => testFixtures.use(fixture));
        values.set(fixture, value);
        deadline.throwIfCancelled();
      }
      phase = "body";
      deadline.throwIfCancelled();
      if (runnerBody === undefined) await definition.run(context);
      else await runnerBody(context, { cleanupBoundary: resources.cleanupBoundary,
        cleanupSnapshot: () => resources.snapshot() });
    } catch (error) {
      if (!deadline.signal.aborted || error !== deadline.signal.reason) recorder.failure(phase, error);
    } finally {
      try {
        await dispatches.drain();
        await recorder.drain();
        // A previously pending step may have started another dispatch while draining.
        await dispatches.drain();
        deadline.throwIfCancelled();
        recorder.checkCoverage();
      } catch (error) {
        if (!deadline.signal.aborted || error !== deadline.signal.reason) recorder.failure("drain", error);
      }
      accepting = false;
      cleanupResult = await resources.close();
    }
  }, execution.deadline);
  const handle = trackInProcessTask(task, { externalEffects: possibleExternalEffects(execution.plan) });
  const worker = await handle.outcome;
  accepting = false;
  const snapshot = task.snapshot();
  const cleanupSnapshot = cleanupResult ?? resourceScope?.snapshot();
  retainLifecycleFailures(recorder, snapshot, worker, cleanupResult);
  const extraSteps = retainCleanupFailures(recorder, cleanupResult, cleanupSnapshot, cleanupErrors, worker);
  const status = snapshot.cancellation?.kind === "deadline" ? "timedOut"
    : recorder.error === undefined ? "passed" : "failed";
  const steps = freezeSteps([...recorder.snapshot(), ...extraSteps]);
  const report: NormalizedCaseReportInput = Object.freeze({
    spec: definition.spec,
    result: Object.freeze({ status, startedAt, durationMs: elapsed(started), steps,
      ...(recorder.error === undefined ? {} : { error: recorder.error }) }),
  });
  validateCaseReport(report, execution.platform);
  return Object.freeze({ report, ...(cleanupSnapshot === undefined ? {} : {
    cleanup: cleanupSnapshot,
  }), worker });
}

function registerFixtureRuntimes(resources: ResourceScope, test: FixtureRuntime,
  worker: FixtureRuntime, errors: Map<string, unknown>): void {
  for (const [id, runtime] of [["kernel.fixture.worker", worker], ["kernel.fixture.test", test]] as const) {
    resources.register({ id, ownership: "owned", cleanup: async () => {
      try { await runtime.close(); return { status: "released" }; }
      catch (error) { errors.set(id, error); throw error; }
    } });
  }
}

function retainLifecycleFailures(recorder: ExecutionRecorder,
  task: ReturnType<ReturnType<typeof startDeadlineTask>["snapshot"]>,
  worker: WorkerStopSnapshot, cleanup: ResourceCleanupResult | undefined): void {
  const diagnostic = { task: { started: task.started, cancellation: task.cancellation,
    cancellationAcknowledged: task.cancellationAcknowledged, clockFailure: task.clockFailure },
    worker, cleanupPublished: cleanup !== undefined };
  if (task.cancellation !== null) {
    const phase = task.cancellation.kind === "deadline" ? "executionDeadline" : "executionCancellation";
    recorder.failure(phase, lifecycleError(task.cancellation.message, phase, diagnostic));
  } else if (worker.failures.length > 0) {
    recorder.failure("executionWorker", lifecycleError(worker.failures[0]!.message,
      "executionWorker", diagnostic));
  }
}

function retainCleanupFailures(recorder: ExecutionRecorder, result: ResourceCleanupResult | undefined,
  snapshot: ResourceCleanupResult | undefined, originals: ReadonlyMap<string, unknown>,
  worker: WorkerStopSnapshot): TestStepResult[] {
  if (result === undefined) return [absentCleanupStep(worker, snapshot)];
  if (result.status === "passed") return [passedLifecycleStep(worker), cleanupStep(result)];
  for (const failure of result.failures) {
    recorder.failure("fixtureTeardown", cleanupFailureError(failure, originals, result));
  }
  return [passedLifecycleStep(worker)];
}

function possibleExternalEffects(plan: import("./plan-contracts.js").ExecutionPlan): "none" | "possible" {
  if (plan.effectDeclaration.kind === "precise") {
    return plan.effectDeclaration.effects.some((effect) => effect.boundary === "external") ? "possible" : "none";
  }
  return plan.effectDeclaration.maximum === "externalEffect"
    || plan.effectDeclaration.maximum === "securitySensitive" ? "possible" : "none";
}

function freezeSteps(steps: readonly TestStepResult[]): readonly TestStepResult[] {
  return Object.freeze(steps.map((step) => Object.freeze({ ...step,
    ...(step.criterionIds === undefined ? {} : { criterionIds: Object.freeze([...step.criterionIds]) }) })));
}

function validateCaseReport(report: NormalizedCaseReportInput, platform: ExecuteCaseOptions["platform"]): void {
  validateReportInput({ run: { id: "kernel.validation", title: "Execution result validation", platform,
    startedAt: report.result.startedAt,
    finishedAt: new Date(Date.parse(report.result.startedAt) + report.result.durationMs).toISOString(),
    app: { id: "kernel.validation", name: "Execution kernel" } }, tests: [report] });
}
