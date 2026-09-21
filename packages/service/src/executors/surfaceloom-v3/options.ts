import type { RunCaseV3Options } from "@surfaceloom/test";

import type { ExecuteRequest } from "../../execution.js";
import { readSafeRecordEnvelope } from "../../safe-data.js";
import { exactKeys } from "../../validation.js";
import type { ResolvedSurfaceLoomV3Case } from "./contracts.js";

export function bindV3Options(resolved: ResolvedSurfaceLoomV3Case,
  request: Readonly<ExecuteRequest>, signal: AbortSignal,
  stagingDirectory: string, outputDirectory: string): RunCaseV3Options {
  const root = readSafeRecordEnvelope(resolved, "ResolvedSurfaceLoomV3Case");
  exactKeys(root, "ResolvedSurfaceLoomV3Case", ["definition", "options"]);
  const options = readSafeRecordEnvelope(root.options, "SurfaceLoomV3CaseOptions");
  exactKeys(options, "SurfaceLoomV3CaseOptions",
    ["platform", "runnerHostId", "run", "surfaces", "execution"],
    ["requiredEvidence", "judge", "evidencePolicy", "executionGate"]);
  const run = readSafeRecordEnvelope(options.run, "SurfaceLoomV3CaseOptions.run");
  exactKeys(run, "SurfaceLoomV3CaseOptions.run", ["title", "app", "hosts"], ["environment"]);
  const execution = readSafeRecordEnvelope(options.execution,
    "SurfaceLoomV3CaseOptions.execution");
  exactKeys(execution, "SurfaceLoomV3CaseOptions.execution", [], ["plan", "environment", "policy",
    "timeoutMs", "cancellationGraceMs", "clock", "cleanupTimeoutMs"]);
  return Object.freeze({
    platform: options.platform as RunCaseV3Options["platform"],
    runnerHostId: options.runnerHostId as string,
    run: Object.freeze({ id: request.runId, title: run.title as string,
      app: run.app as RunCaseV3Options["run"]["app"],
      ...(run.environment === undefined ? {} : {
        environment: run.environment as RunCaseV3Options["run"]["environment"],
      }), hosts: run.hosts as RunCaseV3Options["run"]["hosts"] }),
    surfaces: options.surfaces as RunCaseV3Options["surfaces"],
    ...(options.requiredEvidence === undefined ? {} : {
      requiredEvidence: options.requiredEvidence as RunCaseV3Options["requiredEvidence"],
    }),
    ...(options.judge === undefined ? {} : { judge: options.judge as RunCaseV3Options["judge"] }),
    ...(options.evidencePolicy === undefined ? {} : {
      evidencePolicy: options.evidencePolicy as RunCaseV3Options["evidencePolicy"],
    }),
    ...(options.executionGate === undefined ? {} : {
      executionGate: options.executionGate as RunCaseV3Options["executionGate"],
    }),
    execution: Object.freeze({ ...execution, signal }), stagingDirectory, outputDirectory,
  }) as RunCaseV3Options;
}
