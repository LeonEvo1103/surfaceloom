import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { runCaseV3 } from "@surfaceloom/test";

import { resolveBrowserLaunchOptions } from "../adapter/browser-launch.mjs";
import { referenceAgentBrowserRunOptions } from "../adapter/v3-browser-run-options.mjs";
import {
  assertChildInfrastructureHealthy,
  assertExpectedResourceCleanupFailure,
} from "../showcase/child-health.mjs";
import { createFaultMatrixCase } from "./cases.mjs";
import {
  browserHostId,
  browserSurfaceId,
  evidenceArtifactId,
  faultMatrixRun,
  runnerHostId,
} from "./matrix.mjs";

export async function runFaultMatrixCase(entry,
  { outputRoot, launchOptions, execute = runCaseV3, wrapBackend } = {}) {
  const root = path.resolve(outputRoot ?? defaultOutputRoot(entry.key));
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  const created = createFaultMatrixCase(entry);
  const browser = launchOptions ?? await resolveBrowserLaunchOptions();
  let result;
  try {
    result = await execute(created.definition,
      options(entry, created.definition, root, browser, wrapBackend));
    if (entry.cleanupUnconfirmed) {
      assertExpectedResourceCleanupFailure(result, entry, created.definition.spec,
        "reference-agent.run-work.");
    } else {
      assertChildInfrastructureHealthy(result, entry, created.definition.spec);
    }
  } finally {
    if (entry.cleanupUnconfirmed) await created.recover();
  }
  return Object.freeze({ ...result, root, recovery: created.recovery.recovered,
    cleanupState: created.recovery.cleanup });
}

function options(entry, definition, root, browser, wrapBackend) {
  const reportRunId = `reference-agent.p3-088.${entry.key}.${randomUUID()}`;
  return referenceAgentBrowserRunOptions({ spec: definition.spec, run: faultMatrixRun, reportRunId,
    runnerHostId, browserHostId, browserSurfaceId, requiredArtifactId: evidenceArtifactId,
    requireComplete: entry.incompleteEvidence !== true,
    stagingDirectory: path.join(root, "staging"), outputDirectory: path.join(root, "report"),
    browser, executionTimeoutMs: 12_000,
    cleanupTimeoutMs: entry.cleanupUnconfirmed ? 100 : 5_000,
    runnerHostName: "SurfaceLoom fault-matrix runner", ...(wrapBackend ? { wrapBackend } : {}),
  });
}

function defaultOutputRoot(key) {
  const stamp = new Date().toISOString().replace(/[^0-9]/gu, "");
  return path.join(process.cwd(), ".artifacts", `p3-088-${key}-${stamp}-${process.pid}`);
}
