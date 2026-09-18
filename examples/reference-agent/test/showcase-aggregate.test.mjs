import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { aggregateChildReports } from "../showcase/aggregate.mjs";
import { settleProbeReads } from "../showcase/probe-settlement.mjs";
import { publishAggregateAfterChildCleanup } from "../showcase/publication.mjs";
import { toV3Locator } from "../showcase/v3-browser-session.mjs";
import { createSyntheticChildren } from "./showcase-fixture.mjs";

test("aggregate preserves the honest four-Case verdict and republishes attachments", async (t) => {
  const root = await temporary(t);
  const fixture = await createSyntheticChildren(path.join(root, "children"));
  const bundle = await aggregate(fixture, path.join(root, "final"));
  assert.equal(bundle.report.status, "failed");
  assert.deepEqual({ discovered: bundle.report.summary.discovered,
    passed: bundle.report.summary.passed, failed: bundle.report.summary.failed },
  { discovered: 4, passed: 2, failed: 2 });
  assert.ok(bundle.report.tests.every((item) => item.attempts.state === "known"
    && item.attempts.items[0].result.artifacts.length > 0));
  await Promise.all([stat(bundle.htmlPath), stat(bundle.aiReviewPath), stat(bundle.completionMarkerPath)]);
});

test("damaged or missing attachment blocks aggregate completion", async (t) => {
  for (const mode of ["damaged", "missing"]) {
    const root = await temporary(t, mode);
    const fixture = await createSyntheticChildren(path.join(root, "children"));
    const child = fixture.children[0];
    const artifact = child.bundle.report.tests[0].attempts.items[0].result.artifacts[0];
    const source = path.join(child.directory, artifact.relativePath);
    if (mode === "damaged") await writeFile(source, "damaged");
    else await rm(source);
    await rejectedWithoutFinal(fixture, path.join(root, "final"), /artifact|hash|size|ENOENT/u);
  }
});

test("cross-run, mixed invocation, and duplicate Case results are rejected", async (t) => {
  const root = await temporary(t, "identity");
  const cross = await createSyntheticChildren(path.join(root, "cross"), { crossRun: true });
  await rejectedWithoutFinal(cross, path.join(root, "cross-final"), /invocation/u);
  const left = await createSyntheticChildren(path.join(root, "left"));
  const right = await createSyntheticChildren(path.join(root, "right"));
  await rejectedWithoutFinal({ reportRunId: left.reportRunId,
    children: [left.children[0], right.children[1], left.children[2], left.children[3]] },
  path.join(root, "mixed-final"), /invocation/u);
  await rejectedWithoutFinal({ reportRunId: left.reportRunId,
    children: [left.children[0], left.children[0], left.children[2], left.children[3]] },
  path.join(root, "duplicate-final"), /unique/u);
});

test("aggregate publication failure never manufactures a final complete marker", async (t) => {
  const root = await temporary(t);
  const fixture = await createSyntheticChildren(path.join(root, "children"));
  const output = path.join(root, "final");
  await mkdir(output);
  await writeFile(path.join(output, "sentinel"), "keep");
  await rejectedWithoutFinal(fixture, output, /already exists/u);
});

test("cleanup and rename failure cannot expose a final completion marker", async (t) => {
  for (const mode of ["cleanup", "rename"]) {
    const root = await temporary(t, mode);
    const work = path.join(root, "children");
    const staging = path.join(root, ".aggregate-staging");
    const final = path.join(root, "report");
    await mkdir(work);
    await mkdir(staging);
    await writeFile(path.join(staging, "complete.json"), "staged only");
    const denied = Object.assign(new Error("injected EACCES"), { code: "EACCES" });
    await assert.rejects(publishAggregateAfterChildCleanup({ work,
      aggregateStaging: staging, finalDirectory: final }, {
      remove: async (target) => {
        if (mode === "cleanup" && target === work) throw denied;
        await rm(target, { recursive: true, force: true });
      },
      assertMissing: async () => undefined,
      move: async () => { throw denied; },
    }), /EACCES|cleanup/u);
    await assert.rejects(stat(path.join(final, "complete.json")), { code: "ENOENT" });
  }
});

test("probe settlement leaves no late reader after an immediate UI failure", async () => {
  let active = 0;
  let completions = 0;
  const delayed = () => new Promise((resolve) => {
    active += 1;
    setTimeout(() => { active -= 1; completions += 1; resolve("done"); }, 20);
  });
  await assert.rejects(settleProbeReads([Promise.reject(new Error("UI failed")), delayed(), delayed()]),
    /UI failed/u);
  assert.equal(active, 0);
  const settled = completions;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(completions - settled, 0);
});

test("v3 locator bridge requires canonical role, name, exact, and key", () => {
  const canonical = { kind: "role", key: "approval.approve", role: "button",
    name: "Approve", exact: true };
  assert.deepEqual(toV3Locator(canonical),
    { kind: "testId", key: "approval.approve", value: "approval.approve" });
  for (const forged of [
    { ...canonical, role: "textbox" }, { ...canonical, name: "Deny" },
    { ...canonical, exact: false }, { ...canonical, key: "unknown" },
  ]) assert.throws(() => toV3Locator(forged), /lossless/u);
});

async function aggregate(fixture, output) {
  return aggregateChildReports(fixture.children, output, { reportRunId: fixture.reportRunId });
}

async function rejectedWithoutFinal(fixture, output, pattern) {
  await assert.rejects(aggregate(fixture, output), pattern);
  await assert.rejects(stat(path.join(output, "complete.json")), { code: "ENOENT" });
}

async function temporary(t, suffix = "base") {
  const root = await mkdtemp(path.join(os.tmpdir(), `sl-showcase-${suffix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
