import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertChildInfrastructureHealthy } from "../showcase/child-health.mjs";
import { showcaseCases } from "../showcase/matrix.mjs";
import { runShowcase } from "../showcase/run.mjs";
import { createSyntheticChildren } from "./showcase-fixture.mjs";

test("expected red allows criterion/body aggregation but rejects lifecycle failure kinds", async (t) => {
  const root = await temporary(t, "categories");
  const fixture = await createSyntheticChildren(path.join(root, "children"));
  const child = fixture.children[2];
  const canonical = showcaseCases[2];
  const spec = child.bundle.report.tests[0].spec;
  const healthy = result(child.bundle);
  assert.doesNotThrow(() => assertChildInfrastructureHealthy(healthy, canonical, spec));
  for (const id of [
    "kernel.effectDispatch.9", "kernel.authoring.9", "kernel.acceptanceCriteria.9",
    "kernel.drain.9", "kernel.executionDeadline.9", "kernel.executionCancellation.9",
    "kernel.executionWorker.9", "kernel.fixtureTeardown.9",
  ]) {
    const forged = clone(healthy);
    finalResult(forged).steps.push({ id, title: id, status: "failed", durationMs: 0 });
    assert.throws(() => assertChildInfrastructureHealthy(forged, canonical, spec),
      /not caused only by acceptance criteria/u);
  }
});

test("failed or tainted structured cleanup is infrastructure failure", async (t) => {
  const root = await temporary(t, "cleanup");
  const fixture = await createSyntheticChildren(path.join(root, "children"));
  const child = fixture.children[3];
  const canonical = showcaseCases[3];
  const spec = child.bundle.report.tests[0].spec;
  for (const mutation of [
    (cleanup) => { cleanup.status = "failed"; },
    (cleanup) => { cleanup.tainted = true; },
    (cleanup) => { cleanup.state = "closing"; },
  ]) {
    const unhealthy = clone(result(child.bundle));
    const step = finalResult(unhealthy).steps.find((item) => item.id === "kernel.cleanup");
    const diagnostic = JSON.parse(step.diagnostic);
    mutation(diagnostic.data.cleanup);
    step.diagnostic = JSON.stringify(diagnostic);
    assert.throws(() => assertChildInfrastructureHealthy(unhealthy, canonical, spec),
      /resource cleanup/u);
  }
});

test("fourth-Case teardown failure stops publication and leaves no final complete marker", async (t) => {
  const root = await temporary(t, "teardown");
  const fixture = await createSyntheticChildren(path.join(root, "fixtures"));
  let ordinal = 0;
  const executeChild = async (_definition, options) => {
    const child = fixture.children[ordinal];
    ordinal += 1;
    await mkdir(options.stagingDirectory, { recursive: true });
    await cp(child.directory, options.outputDirectory, { recursive: true });
    const bundle = remapBundle(child.bundle, options.outputDirectory);
    if (ordinal === 4) {
      const attempt = finalResult({ bundle });
      const cleanup = attempt.steps.find((step) => step.id === "kernel.cleanup");
      const diagnostic = JSON.parse(cleanup.diagnostic);
      diagnostic.data.cleanup.status = "failed";
      diagnostic.data.cleanup.tainted = true;
      diagnostic.data.cleanup.failures = [{ code: "cleanupFailed", resourceId: "fixture.http" }];
      cleanup.status = "failed";
      cleanup.diagnostic = JSON.stringify(diagnostic);
      attempt.steps.push({ id: "kernel.fixtureTeardown.9", title: "Teardown fixture",
        status: "failed", durationMs: 0 });
    }
    const status = finalResult({ bundle }).status;
    return { bundle, exitCode: status === "passed" ? 0 : 1 };
  };
  const outputRoot = path.join(root, "showcase");
  await assert.rejects(runShowcase({ outputRoot, executeChild,
    launchOptions: { engine: "chromium", executablePath: "/not-launched" } }),
  /infrastructure is unhealthy/u);
  assert.equal(ordinal, 4);
  await assert.rejects(stat(path.join(outputRoot, "report", "complete.json")), { code: "ENOENT" });
});

function result(bundle) { return { bundle, exitCode: bundle.report.status === "passed" ? 0 : 1 }; }
function finalResult(result) {
  const attempts = result.bundle.report.tests[0].attempts;
  return attempts.items.find((item) => item.id === attempts.finalAttemptId).result;
}
function clone(value) { return structuredClone(value); }
function remapBundle(source, directory) {
  const bundle = clone(source);
  bundle.directory = directory;
  bundle.completionMarkerPath = path.join(directory, "complete.json");
  bundle.reportPath = path.join(directory, "report.json");
  bundle.htmlPath = path.join(directory, "index.html");
  bundle.aiReviewPath = path.join(directory, "ai-review.md");
  return bundle;
}
async function temporary(t, suffix) {
  const root = await mkdtemp(path.join(os.tmpdir(), `sl-showcase-health-${suffix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
