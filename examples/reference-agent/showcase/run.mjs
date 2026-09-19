import { randomUUID } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { runCaseV3 } from "@surfaceloom/test";

import { resolveBrowserLaunchOptions } from "../adapter/browser-launch.mjs";
import { referenceAgentBrowserRunOptions } from "../adapter/v3-browser-run-options.mjs";
import { aggregateChildReports } from "./aggregate.mjs";
import { createShowcaseCase } from "./cases.mjs";
import { assertChildInfrastructureHealthy } from "./child-health.mjs";
import {
  browserHostId,
  browserSurfaceId,
  probeArtifactId,
  runnerHostId,
  showcaseCases,
  showcaseRun,
} from "./matrix.mjs";
import { publishAggregateAfterChildCleanup } from "./publication.mjs";

export async function runShowcase({ outputRoot, launchOptions, executeChild = runCaseV3 } = {}) {
  const root = path.resolve(outputRoot ?? defaultOutputRoot());
  const reportRunId = `reference-agent.m1.${randomUUID()}`;
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  await mkdir(root, { mode: 0o700 });
  const work = path.join(root, "children");
  const aggregateStaging = path.join(root, ".aggregate-staging");
  const finalDirectory = path.join(root, "report");
  await mkdir(work, { mode: 0o700 });
  const browser = launchOptions ?? await resolveBrowserLaunchOptions();
  const children = [];
  const cleanupReceipts = [];
  try {
    for (const entry of showcaseCases) {
      const stagingDirectory = path.join(work, entry.key, "staging");
      const outputDirectory = path.join(work, entry.key, "report");
      const definition = createShowcaseCase(entry);
      const result = await executeChild(definition, options({ entry, definition,
        stagingDirectory, outputDirectory, browser, reportRunId }));
      assertChildInfrastructureHealthy(result, entry, definition.spec);
      const actual = result.bundle.report.tests[0]?.attempts;
      const status = actual?.state === "known"
        ? actual.items.find((item) => item.id === actual.finalAttemptId)?.result.status : undefined;
      if (result.bundle.report.tests.length !== 1 || status !== entry.expectedStatus
          || result.exitCode !== (entry.expectedStatus === "passed" ? 0 : 1)) {
        throw new Error(`Child ${entry.id} produced an unexpected business verdict.`);
      }
      await rm(stagingDirectory, { recursive: true, force: false });
      await assertMissing(stagingDirectory);
      cleanupReceipts.push(Object.freeze({ caseId: entry.id, staging: "removed" }));
      children.push(Object.freeze({ caseId: entry.id, directory: outputDirectory,
        reportRunId, bundle: result.bundle }));
    }
    const staged = await aggregateChildReports(children, aggregateStaging, { reportRunId });
    await publishAggregateAfterChildCleanup({ work, aggregateStaging, finalDirectory });
    cleanupReceipts.push(Object.freeze({ resource: "child-reports", status: "removed" }));
    const bundle = remapBundle(staged, finalDirectory);
    return Object.freeze({ root, reportRunId, bundle,
      exitCode: bundle.report.status === "failed" ? 1 : 0,
      cleanupReceipts: Object.freeze(cleanupReceipts) });
  } catch (error) {
    const cleanupFailures = [];
    try {
      await rm(work, { recursive: true, force: true });
      cleanupReceipts.push(Object.freeze({ resource: "child-work", status: "removed-after-failure" }));
    } catch (cleanupError) { cleanupFailures.push(cleanupError); }
    try { await rm(aggregateStaging, { recursive: true, force: true }); }
    catch (cleanupError) { cleanupFailures.push(cleanupError); }
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures],
        "Showcase failed and published output cleanup was not fully confirmed.");
    }
    throw error;
  }
}

function options({ entry, definition, stagingDirectory, outputDirectory, browser, reportRunId }) {
  return referenceAgentBrowserRunOptions({ spec: definition.spec, run: showcaseRun, reportRunId,
    runnerHostId, browserHostId, browserSurfaceId, requiredArtifactId: probeArtifactId,
    requireComplete: !entry.incomplete, stagingDirectory, outputDirectory, browser,
  });
}

function remapBundle(bundle, directory) {
  return Object.freeze({ ...bundle, directory,
    completionMarkerPath: path.join(directory, "complete.json"),
    reportPath: path.join(directory, "report.json"),
    htmlPath: path.join(directory, "index.html"),
    aiReviewPath: path.join(directory, "ai-review.md") });
}

function defaultOutputRoot() {
  const stamp = new Date().toISOString().replace(/[^0-9]/gu, "");
  return path.join(process.cwd(), ".artifacts", `m1-showcase-${stamp}-${process.pid}`);
}

async function assertMissing(candidate) {
  try { await access(candidate); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Cleanup did not remove ${candidate}.`);
}
