import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RequiredArtifactPublicationError,
  type ReportHostV3,
} from "@surfaceloom/reporter";

import { cliFailureExitCode } from "../src/cli/main.js";
import { suiteExitCodes } from "../src/report/contracts.js";
import { defineCaseV3 } from "../src/definition-v3.js";
import { defineExecutionPlan } from "../src/plan.js";
import { ResourceScope } from "../src/resources.js";
import {
  prepareCaseV3,
  publishPreparedCaseV3,
  runCaseV3,
} from "../src/runner-v3.js";
import type {
  CaseContextV3,
  RunCaseV3Options,
} from "../src/runner-v3-contracts.js";
import type {
  BrowserSurfaceBackendPort,
  NativeSurfaceBackendPort,
  NativeSurfaceSessionPort,
  SurfaceLease,
} from "../src/surfaces/contracts.js";

const caseId = "runner.v3.contract";
const requiredArtifactId = "required-result";

test("runner-owned v3 path acquires two real surfaces, seals evidence, cleans up, and publishes",
  async (context) => {
    const root = await temporary(context);
    const fixture = runnerFixture(root);
    const result = await runCaseV3(fixture.definition, fixture.options);

    assert.equal(result.exitCode, 0);
    assert.equal(result.bundle.report.schemaVersion, "surfaceloom.report/v3");
    assert.equal(result.bundle.report.run.provenance.kind, "native");
    assert.equal(result.bundle.report.run.hosts.state, "known");
    assert.equal(result.bundle.report.run.surfaces.state, "known");
    if (result.bundle.report.run.surfaces.state === "known") {
      assert.deepEqual(result.bundle.report.run.surfaces.value.map((surface) => surface.id),
        ["desktop", "page"]);
    }
    const attempts = result.bundle.report.tests[0]!.attempts;
    assert.equal(attempts.state, "known");
    if (attempts.state === "known") {
      assert.equal(attempts.finalAttemptId, "attempt-1");
      assert.deepEqual(attempts.items[0]!.executionPlatforms, ["macos", "web"]);
      assert.ok(attempts.items[0]!.result.artifacts.some((artifact) =>
        artifact.id === requiredArtifactId && artifact.captureStatus === "captured"));
    }
    assert.deepEqual(fixture.events, [
      "browser.launch", "native.prepare", "native.acquire", "browser.readText",
      "native.find", "native.cleanup", "browser.close", "lease.release",
    ]);
    assert.equal(typeof JSON.parse(await readFile(result.bundle.completionMarkerPath, "utf8")),
      "object");
  });

test("runner cleanup stop aborts before a lease callback after session cleanup is unconfirmed",
  async () => {
    const scope = new ResourceScope({ cleanupTimeoutMs: 100,
      cleanupDeadlineAt: performance.now() + 1_000 });
    let leaseSawStop = false;
    scope.register({ id: "lease", ownership: "owned", cleanup: () => {
      leaseSawStop = scope.cleanupBoundary.signal.aborted;
      return { status: "released" };
    } });
    scope.register({ id: "session", ownership: "owned", cleanup: () => ({
      status: "unconfirmed", reason: "session close proof missing",
    }) });
    const result = await scope.close();
    assert.equal(result.status, "failed");
    assert.equal(leaseSawStop, true);
    assert.equal(scope.cleanupBoundary.signal.aborted, true);
  });

test("required evidence missing fails before publication and creates no completion marker",
  async (context) => {
    const root = await temporary(context);
    const fixture = runnerFixture(root, { submitRequired: false });
    await assert.rejects(runCaseV3(fixture.definition, fixture.options),
      /Required evidence validation failed/u);
    await assert.rejects(stat(path.join(fixture.options.outputDirectory, "complete.json")),
      { code: "ENOENT" });
  });

test("staging mutation after genuine materialization fails reporter publication and keeps CLI nonzero",
  async (context) => {
    const root = await temporary(context);
    const fixture = runnerFixture(root);
    const prepared = await prepareCaseV3(fixture.definition, fixture.options);
    const attempts = prepared.input.tests[0]!.attempts;
    assert.equal(attempts.state, "known");
    if (attempts.state !== "known") throw new Error("Expected runner-owned attempts.");
    const artifact = attempts.items[0]!.result.artifacts?.find((item) =>
      item.id === requiredArtifactId);
    assert.equal(artifact?.captureStatus, "captured");
    if (artifact?.captureStatus !== "captured") throw new Error("Expected captured evidence.");
    await writeFile(artifact.sourcePath, "mutated after runner receipt");

    await assert.rejects(
      publishPreparedCaseV3(prepared, fixture.options.outputDirectory),
      (error: unknown) => error instanceof RequiredArtifactPublicationError
        && error.failures[0]?.code === "copyChanged"
        && cliFailureExitCode(error) === suiteExitCodes.cliError,
    );
    assert.notEqual(suiteExitCodes.cliError, 0);
    await assert.rejects(stat(path.join(fixture.options.outputDirectory, "complete.json")),
      { code: "ENOENT" });
    await assert.rejects(stat(fixture.options.outputDirectory), { code: "ENOENT" });
  });

test("legacy v2 execution remains available without manufacturing v3 context", async () => {
  const publicApi = await import("../src/index.js");
  assert.equal("RunnerExecutionAuthority" in publicApi, false);
  assert.equal("SurfaceAcquisitionRegistry" in publicApi, false);
  assert.equal("materializeEvidenceV3" in publicApi, false);
  assert.equal("prepareCaseV3" in publicApi, false);
  const report = await publicApi.executeCase({
    spec: contractSpec("legacy.v2.compat", ["web"]),
    run: async (caseContext) => {
      assert.equal("surface" in caseContext, false);
      assert.equal("evidence" in caseContext, false);
      await caseContext.criterion("verified", () => assert.ok(true));
    },
  }, { platform: "web" });
  assert.equal(report.result.status, "passed");
  assert.equal("attempts" in report, false);
});

function runnerFixture(root: string, behavior: { submitRequired?: boolean } = {}) {
  const events: string[] = [];
  const browserBackend: BrowserSurfaceBackendPort = {
    hostId: "browser-host",
    capabilities: ["browser.dom.inspect"],
    launch: async (_requirement, call) => {
      call.beforeSubmit();
      events.push("browser.launch");
      return {
        identity: { hostId: "browser-host", sessionId: "browser-session" },
        invoke: async (action, operation) => {
          operation.beforeSubmit();
          events.push(`browser.${action.kind}`);
          return "visible text";
        },
        close: async () => {
          events.push("browser.close");
          return { kind: "browserSessionClosed", hostId: "browser-host",
            sessionId: "browser-session" };
        },
      };
    },
  };
  const lease: SurfaceLease = {
    id: "browser-lease",
    release: () => { events.push("lease.release"); return { status: "released" }; },
  };
  const nativeBackend: NativeSurfaceBackendPort<"macos"> = {
    hostId: "native-host",
    platform: "macos",
    backend: "ax",
    capabilities: ["ui.inspect"],
    prepare: (requirement, setup) => {
      events.push("native.prepare");
      setup.registerResource({ id: "surface.native.session.desktop", ownership: "owned",
        cleanup: () => { events.push("native.cleanup"); return { status: "released" }; } });
      return { acquire: async (call) => {
        call.beforeSubmit();
        events.push("native.acquire");
        return {
          ownership: requirement.acquisition === "launch" ? "owned" : "borrowed",
          platform: "macos",
          backend: "ax",
          capabilities: ["ui.inspect"],
          invoke: async (action, _setup, operation) => {
            operation.beforeSubmit();
            events.push(`native.${action.kind}`);
            return { found: true };
          },
        } as NativeSurfaceSessionPort<"macos", typeof requirement.acquisition extends "launch"
          ? "owned" : "borrowed">;
      } };
    },
  };
  const spec = contractSpec(caseId, ["macos", "web"]);
  const definition = defineCaseV3({
    spec,
    run: async (caseContext: CaseContextV3) => {
      const browser = caseContext.surface("page");
      assert.equal(browser.kind, "browser");
      if (browser.kind !== "browser") throw new Error("Expected browser facade.");
      await browser.perform({ kind: "readText", locator: {
        kind: "testId", key: "testId", value: "status",
      } });
      const native = caseContext.surface("desktop");
      assert.equal(native.kind, "native");
      if (native.kind !== "native" || native.platform !== "macos") {
        throw new Error("Expected macOS native facade.");
      }
      await native.perform({ kind: "find", locator: {
        backend: "ax", identifier: "status",
      } });
      if (behavior.submitRequired !== false) {
        caseContext.evidence.submit({ id: "case-result", artifactId: requiredArtifactId,
          content: { kind: "probe", probeId: "case-result", resource: "case.result",
            outcome: "observed", value: { passed: true } } });
      }
      await caseContext.criterion("verified", () => assert.ok(true));
    },
  });
  const plan = defineExecutionPlan({
    spec,
    requirements: { host: { os: ["macos"] }, surfaces: {
      page: { kind: "browser", capabilities: ["browser.dom.inspect"] },
      desktop: { kind: "desktop", capabilities: ["ui.inspect"] },
    } },
    effects: [
      { resource: "browser.session", operation: "execute", boundary: "local",
        securitySensitive: false, recovery: "unknown" },
      { resource: "browser.readText", operation: "read", boundary: "local",
        securitySensitive: false, recovery: "notNeeded" },
    ],
  });
  const hosts: readonly ReportHostV3[] = [
    { id: "runner-host", os: "macos" },
    { id: "browser-host", os: "linux" },
    { id: "native-host", os: "macos" },
  ];
  const options: RunCaseV3Options = {
    platform: "macos",
    runnerHostId: "runner-host",
    run: { id: "run-v3", title: "Runner v3 contract", app: {
      id: "fixture-app", name: "Fixture App",
    }, hosts },
    surfaces: [
      { kind: "browser", backend: browserBackend, lease, requirement: {
        kind: "browser", surfaceId: "page", expectedHostId: "browser-host",
        capabilities: ["browser.dom.inspect"], engine: "chromium",
      } },
      { kind: "native", backend: nativeBackend, requirement: {
        kind: "native", surfaceId: "desktop", expectedHostId: "native-host",
        platform: "macos", backend: "ax", acquisition: "launch",
        capabilities: ["ui.inspect"], target: "fixture-app",
      } },
    ],
    requiredEvidence: [{ artifactId: requiredArtifactId, requireComplete: true }],
    execution: {
      plan,
      environment: { platform: "macos", host: { os: "macos" }, surfaces: {
        page: { kind: "browser", capabilities: ["browser.dom.inspect"] },
        desktop: { kind: "desktop", capabilities: ["ui.inspect"] },
      } },
      policy: { maximumSideEffect: "writesLocal", grants: [
        { resource: "browser.session", operations: ["execute"], boundaries: ["local"],
          allowUnknownRecovery: true },
        { resource: "browser.readText", operations: ["read"], boundaries: ["local"] },
      ] },
      timeoutMs: 2_000,
      cleanupTimeoutMs: 500,
    },
    stagingDirectory: path.join(root, "staging"),
    outputDirectory: path.join(root, "report"),
  };
  return { definition, events, options };
}

function contractSpec(id: string, platforms: readonly ("macos" | "web")[]) {
  return {
    id,
    locale: "en-US",
    platforms,
    suite: { id: "runner.v3", name: "Runner v3" },
    name: "Runner v3 contract",
    intent: "Prove runner-owned surface and evidence publication contracts.",
    preconditions: [],
    acceptanceCriteria: [{ id: "verified", text: "The observation is verified." }],
    sideEffect: "writesLocal" as const,
  };
}

async function temporary(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runner-v3-contract-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
