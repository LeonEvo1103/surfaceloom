import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CaseSpec } from "@surfaceloom/core";

import { defineCaseV3 } from "../src/definition-v3.js";
import { defineExecutionPlan } from "../src/plan.js";
import { runCaseV3 } from "../src/runner-v3.js";
import type { RunCaseV3Options } from "../src/runner-v3-contracts.js";
import { RunCaseV3Error } from "../src/runner-v3-error.js";
import { pathsOverlap } from "../src/runner-v3-paths.js";
import type { BrowserSurfaceBackendPort, BrowserSurfaceSessionPort } from "../src/surfaces/contracts.js";

test("path overlap recognizes only exact paths and real ancestor boundaries", () => {
  const parent = path.resolve("/tmp/surfaceloom-paths/staging");
  assert.equal(pathsOverlap(parent, parent), true);
  assert.equal(pathsOverlap(parent, path.join(parent, "child")), true);
  assert.equal(pathsOverlap(path.join(parent, "child"), parent), true);
  assert.equal(pathsOverlap(parent, path.join(parent, "..report")), true);
  assert.equal(pathsOverlap(parent, path.join(parent, "...")), true);
  assert.equal(pathsOverlap(parent, path.join(path.dirname(parent), "..report")), false);
  assert.equal(pathsOverlap(parent, path.join(path.dirname(parent), "...")), false);
  assert.equal(pathsOverlap(parent, path.join(path.dirname(parent), "staging-sibling")), false);
});

test("active claims reject identical, one-sided, cross, ancestor, and descendant conflicts",
  async (context) => {
    const root = await temporary(context);
    const spec = caseSpec("runner.v3.active-path-claim");
    const definition = passingCase(spec);
    let launches = 0;
    let openLaunch!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { openLaunch = resolve; });
    const activeRoot = path.join(root, "active");
    const active = options(activeRoot, spec, delayedBackend(async () => {
      launches += 1; signalStarted(); await gate;
    }));
    const running = runCaseV3(definition, active);
    await started;

    const staging = active.stagingDirectory;
    const output = active.outputDirectory;
    const conflicts: Array<readonly [string, string]> = [
      [staging, output],
      [staging, path.join(root, "same-staging-output")],
      [path.join(root, "same-output-staging"), output],
      [output, path.join(root, "cross-output")],
      [path.join(root, "cross-staging"), staging],
      [activeRoot, path.join(root, "ancestor-output")],
      [path.join(staging, "child"), path.join(root, "descendant-output")],
      [path.join(staging, "..report"), path.join(root, "dot-name-output")],
      [path.join(staging, "..."), path.join(root, "ellipsis-output")],
    ];
    for (const [candidateStaging, candidateOutput] of conflicts) {
      const candidate = options(path.join(root, `candidate-${launches}`), spec,
        backend(() => { launches += 1; }));
      (candidate as MutablePaths).stagingDirectory = candidateStaging;
      (candidate as MutablePaths).outputDirectory = candidateOutput;
      await assert.rejects(runCaseV3(definition, candidate), /active in-process run|must be disjoint/u);
    }
    assert.equal(launches, 1);

    const legalSibling = options(path.join(root, "legal"), spec, backend(() => { launches += 1; }));
    (legalSibling as MutablePaths).stagingDirectory = path.join(activeRoot, "..report");
    (legalSibling as MutablePaths).outputDirectory = path.join(root, "legal-output");
    const unrelated = options(path.join(root, "unrelated"), spec, backend(() => { launches += 1; }));
    await Promise.all([runCaseV3(definition, legalSibling), runCaseV3(definition, unrelated)]);
    assert.equal(launches, 3);

    openLaunch();
    await running;
  });

test("a terminal acquisition failure releases its claim for a later run", async (context) => {
  const root = await temporary(context);
  const spec = caseSpec("runner.v3.path-release");
  const definition = passingCase(spec);
  let launches = 0;
  const failed = options(root, spec, {
    hostId: "browser-host", capabilities: ["browser.dom.inspect"],
    launch: async (_requirement, call) => {
      call.beforeSubmit(); launches += 1; throw new Error("synthetic acquisition failure");
    },
  });
  await assert.rejects(runCaseV3(definition, failed), (error: unknown) =>
    error instanceof RunCaseV3Error
      && error.primaryCause?.message === "synthetic acquisition failure");
  const retry = options(root, spec, backend(() => { launches += 1; }));
  const result = await runCaseV3(definition, retry);
  assert.equal(result.exitCode, 0);
  assert.equal(launches, 2);
});

test("a noncooperative producer keeps its process-local path claim sticky", async (context) => {
  const root = await temporary(context);
  const spec = caseSpec("runner.v3.path-sticky");
  let launches = 0;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const hanging = defineCaseV3({ spec, run: () => {
    signalStarted();
    return new Promise<void>(() => undefined);
  } });
  const stop = new AbortController();
  const first = options(root, spec, backend(() => { launches += 1; }));
  (first.execution as { signal?: AbortSignal }).signal = stop.signal;
  const running = runCaseV3(hanging, first);
  await started;
  stop.abort(new Error("stop noncooperative producer"));
  await assert.rejects(running, /publishable terminal state/u);
  const second = options(root, spec, backend(() => { launches += 1; }));
  await assert.rejects(runCaseV3(hanging, second), /active in-process run/u);
  assert.equal(launches, 1);
});

type MutablePaths = RunCaseV3Options & { stagingDirectory: string; outputDirectory: string };

function passingCase(spec: CaseSpec) {
  return defineCaseV3({ spec, run: async (caseContext) => {
    await caseContext.criterion("verified", () => assert.ok(true));
  } });
}

function options(root: string, spec: CaseSpec, browser: BrowserSurfaceBackendPort): RunCaseV3Options {
  const surfaces = { page: { kind: "browser" as const,
    capabilities: ["browser.dom.inspect" as const] } };
  return { platform: "web", runnerHostId: "runner-host",
    run: { id: `run-${spec.id}`, title: "Path claim audit", app: {
      id: "path-audit", name: "Path Audit",
    }, hosts: [{ id: "runner-host", os: "linux" }, { id: "browser-host", os: "linux" }] },
    surfaces: [{ kind: "browser", backend: browser, requirement: {
      kind: "browser", surfaceId: "page", expectedHostId: "browser-host",
      capabilities: ["browser.dom.inspect"], engine: "chromium",
    } }],
    execution: { plan: defineExecutionPlan({ spec, requirements: { surfaces }, effects: [{
      resource: "browser.session", operation: "execute", boundary: "local",
      securitySensitive: false, recovery: "unknown",
    }] }), environment: { platform: "web", host: { os: "linux" }, surfaces },
    policy: { maximumSideEffect: "writesLocal", grants: [{ resource: "browser.session",
      operations: ["execute"], boundaries: ["local"], allowUnknownRecovery: true }] },
    timeoutMs: 2_000, cleanupTimeoutMs: 100 },
    stagingDirectory: path.join(root, "staging"), outputDirectory: path.join(root, "output") };
}

function backend(beforeLaunch?: () => void): BrowserSurfaceBackendPort {
  return delayedBackend(async () => { beforeLaunch?.(); });
}

function delayedBackend(beforeSession: () => Promise<void>): BrowserSurfaceBackendPort {
  return { hostId: "browser-host", capabilities: ["browser.dom.inspect"],
    launch: async (_requirement, call) => {
      call.beforeSubmit();
      await beforeSession();
      return session();
    } };
}

function session(): BrowserSurfaceSessionPort {
  return { identity: { hostId: "browser-host", sessionId: "session" },
    invoke: async (_action, call) => { call.beforeSubmit(); return null; },
    close: async () => ({ kind: "browserSessionClosed", hostId: "browser-host",
      sessionId: "session" }) };
}

function caseSpec(id: string): CaseSpec {
  return { id, locale: "en-US", platforms: ["web"], suite: { id: "runner.v3", name: "Runner v3" },
    name: "Path claim audit", intent: "Audit process-local path ownership.", preconditions: [],
    acceptanceCriteria: [{ id: "verified", text: "The path claim remains authoritative." }],
    sideEffect: "writesLocal" };
}

async function temporary(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runner-v3-paths-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
