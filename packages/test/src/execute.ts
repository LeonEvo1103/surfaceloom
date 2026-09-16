import { FixtureRuntime, type FixtureDefinition } from "@surfaceloom/core";
import { validateReportInput, type NormalizedCaseReportInput } from "@surfaceloom/reporter";
import type { CaseContext, CaseDefinition, ExecuteCaseOptions } from "./contracts.js";
import { defineCase } from "./definition.js";
import { elapsed, ExecutionRecorder } from "./recorder.js";

/**
 * Executes one case with owned test/worker scopes and returns canonical report/v2 input.
 * No deadlines, forced cancellation, capability negotiation, or effect enforcement yet.
 * Invalid definitions/options reject before setup; execution failures become failed results.
 */
export async function executeCase(
  input: CaseDefinition,
  options: ExecuteCaseOptions,
): Promise<NormalizedCaseReportInput> {
  const platform = options.platform;
  const definition = defineCase(input);
  if (!definition.spec.platforms.includes(platform)) {
    throw new Error(`Case ${definition.spec.id} does not support platform ${platform}.`);
  }
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const recorder = new ExecutionRecorder(definition.spec);
  const worker = new FixtureRuntime("worker");
  const scope = worker.createTestScope();
  const values = new Map<FixtureDefinition<unknown>, unknown>();
  const context: CaseContext = Object.freeze({
    fixture: <T>(fixture: FixtureDefinition<T>): T => {
      recorder.assertOpen();
      if (!values.has(fixture)) throw new Error(`Fixture ${fixture.id} is not a declared case fixture.`);
      return values.get(fixture) as T;
    },
    step: recorder.step.bind(recorder),
    criterion: recorder.criterion.bind(recorder),
  });
  let phase = "fixtureSetup";
  try {
    for (const fixture of definition.fixtures ?? []) {
      const value = await recorder.stage(phase, `Setup fixture: ${fixture.id}`, () => scope.use(fixture));
      values.set(fixture, value);
    }
    phase = "body";
    await definition.run(context);
  } catch (error) {
    recorder.failure(phase, error);
  } finally {
    // Registered steps settle before fixture teardown, even if the body throws early.
    // Detached tasks outside this API are not tracked and cannot be forcibly stopped.
    await recorder.drain();
    recorder.checkCoverage();
    for (const [runtime, label] of [[scope, "test"], [worker, "worker"]] as const) {
      try {
        await recorder.stage("fixtureTeardown", `Teardown ${label} fixtures`, () => runtime.close());
      } catch {
        // The stage already retained this error. Always attempt the remaining scope.
      }
    }
  }

  const report: NormalizedCaseReportInput = Object.freeze({
    spec: definition.spec,
    result: Object.freeze({
      status: recorder.error === undefined ? "passed" : "failed",
      startedAt,
      durationMs: elapsed(started),
      steps: recorder.snapshot(),
      ...(recorder.error === undefined ? {} : { error: recorder.error }),
    }),
  });
  // Reporter owns validation. This temporary envelope is never emitted as a run.
  validateReportInput({
    run: {
      id: "kernel.validation", title: "Execution result validation", platform,
      startedAt, finishedAt: new Date(Date.parse(startedAt) + report.result.durationMs).toISOString(),
      app: { id: "kernel.validation", name: "Execution kernel" },
    },
    tests: [report],
  });
  return report;
}
