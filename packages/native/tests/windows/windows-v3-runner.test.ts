import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  defineCaseV3, defineExecutionPlan, runCaseV3, type CaseContextV3, type RunCaseV3Options,
} from "@surfaceloom/test";

import { createWindowsNativeSurfaceBackend } from "../../src/windows/v3/backend.js";

const fixture = fileURLToPath(new URL("../fixtures/windows-v1-scripted-host.mjs", import.meta.url));
const target = path.resolve(path.dirname(fixture), "fixture-app.exe");

test("v3 runner drives the real Windows adapter over a scripted child wire host", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "surfaceloom-windows-v3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = {
    id: "windows.v3.scripted.binding",
    locale: "zh-CN",
    platforms: ["windows"] as const,
    suite: { id: "windows.v3", name: "Windows 原生桥接" },
    name: "脚本协议宿主完成原生查询",
    intent: "验证公开 Windows v3 adapter 通过真实子进程协议执行严格 UIA 查询并清理资源。",
    preconditions: [],
    acceptanceCriteria: [{ id: "found", text: "严格定位返回预期元素。" }],
    sideEffect: "writesLocal" as const,
  };
  const definition = defineCaseV3({ spec, run: async (context: CaseContextV3) => {
    const surface = context.surface("desktop");
    assert.equal(surface.kind, "native");
    if (surface.kind !== "native" || surface.platform !== "windows") throw new Error("Expected Windows surface.");
    const result = await surface.perform({ kind: "find", locator: {
      backend: "uia", automationId: "fixture.name", controlType: "edit",
    } }) as { snapshot: { automationId: string } };
    await context.criterion("found", () => assert.equal(result.snapshot.automationId, "fixture.name"));
  } });
  const plan = defineExecutionPlan({ spec, requirements: { host: { os: ["windows"] }, surfaces: {
    desktop: { kind: "desktop", capabilities: ["ui.inspect"] },
  } }, effects: [
    { resource: "native.app.launch", operation: "execute", boundary: "local",
      securitySensitive: false, recovery: "unknown" },
    { resource: "native.ui.inspect", operation: "read", boundary: "local",
      securitySensitive: false, recovery: "notNeeded" },
  ] });
  const backend = createWindowsNativeSurfaceBackend({ hostId: "windows-scripted",
    process: { executable: process.execPath, cwd: path.dirname(fixture), argv: [fixture, "ok"],
      closeGraceMs: 20, forceCloseMs: 500 }, environmentCapabilities: ["app.launch", "ui.inspect"],
    targets: { "fixture-app": { kind: "launch", options: { executablePath: target } } } });
  let gateReleases = 0;
  const options: RunCaseV3Options = { platform: "windows", runnerHostId: "runner-host",
    executionGate: { id: "windows-scripted-execution-gate", release: async () => {
      gateReleases += 1; return { status: "released" };
    }, quarantine: () => { throw new Error("Passing scripted execution must not quarantine."); } },
    run: { id: "windows-v3-run", title: "Windows v3 scripted binding", app: {
      id: "fixture-app", name: "Fixture App",
    }, hosts: [{ id: "runner-host", os: "windows" }, { id: "windows-scripted", os: "windows" }] },
    surfaces: [{ kind: "native", backend, requirement: { kind: "native", surfaceId: "desktop",
      expectedHostId: "windows-scripted", platform: "windows", backend: "uia", acquisition: "launch",
      capabilities: ["ui.inspect"], target: "fixture-app", timeoutMs: 1_000 } }],
    execution: { plan, environment: { platform: "windows", host: { os: "windows" }, surfaces: {
      desktop: { kind: "desktop", capabilities: ["ui.inspect"] },
    } }, policy: { maximumSideEffect: "writesLocal", grants: [
      { resource: "native.app.launch", operations: ["execute"], boundaries: ["local"],
        allowUnknownRecovery: true },
      { resource: "native.ui.inspect", operations: ["read"], boundaries: ["local"] },
    ] }, timeoutMs: 300_000, cleanupTimeoutMs: 1_000 },
    stagingDirectory: path.join(root, "staging"), outputDirectory: path.join(root, "report") };
  const result = await runCaseV3(definition, options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.bundle.report.status, "passed");
  const attempt = result.bundle.report.tests[0]?.attempts;
  assert.equal(attempt?.state, "known");
  assert.equal(result.bundle.report.run.surfaces.state, "known");
  assert.equal(gateReleases, 1, "native host cleanup must finish before the execution gate is released");
});

for (const mode of ["bad-end-proof", "inherited-stdio"] as const) {
  test(`${mode} cleanup failure forces an honest red v3 verdict`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `surfaceloom-windows-v3-${mode}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { definition, options } = cleanupFailureFixture(root, mode);
    const result = await runCaseV3(definition, options);
    assert.equal(result.exitCode, 1);
    assert.equal(result.bundle.report.status, "failed");
    const attempts = result.bundle.report.tests[0]?.attempts;
    assert.equal(attempts?.state, "known");
    if (attempts?.state === "known") {
      const cleanup = attempts.items[0]?.result.steps.find((step) =>
        step.id.startsWith("kernel.fixtureTeardown."));
      assert.equal(cleanup?.status, "failed");
      assert.match(cleanup?.diagnostic ?? "", /"tainted":true/u);
    }
    await stat(path.join(root, "report", "complete.json"));
  });
}

test("v3 action deadline expires before submission and sends zero action frames", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "surfaceloom-windows-v3-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "wire.log");
  const spec = { id: "windows.v3.deadline.zero-action", locale: "en-US", platforms: ["windows"] as const,
    suite: { id: "windows.v3.deadline", name: "Windows deadline" }, name: "No late action submission",
    intent: "A lookup that outlives the action deadline cannot submit the mutation.", preconditions: [],
    acceptanceCriteria: [{ id: "deadline", text: "The action stops before submission." }],
    sideEffect: "writesLocal" as const };
  const definition = defineCaseV3({ spec, run: async (context: CaseContextV3) => {
    const surface = context.surface("desktop");
    if (surface.kind !== "native" || surface.platform !== "windows") throw new Error("Expected Windows surface.");
    await context.criterion("deadline", () => assert.rejects(surface.perform({ kind: "invoke",
      locator: { backend: "uia", automationId: "fixture.name" } }, { timeoutMs: 10 })));
  } });
  const plan = defineExecutionPlan({ spec, requirements: { host: { os: ["windows"] }, surfaces: {
    desktop: { kind: "desktop", capabilities: ["ui.invoke"] },
  } }, effects: [
    { resource: "native.app.launch", operation: "execute", boundary: "local",
      securitySensitive: false, recovery: "unknown" },
    { resource: "native.ui.invoke", operation: "write", boundary: "local",
      securitySensitive: false, recovery: "unknown" },
  ] });
  const backend = createWindowsNativeSurfaceBackend({ hostId: "windows-scripted",
    process: { executable: process.execPath, cwd: path.dirname(fixture), argv: [fixture, "slow-find", marker],
      closeGraceMs: 20, forceCloseMs: 500 }, environmentCapabilities: ["app.launch", "ui.invoke"],
    targets: { "fixture-app": { kind: "launch", options: { executablePath: target } } } });
  const result = await runCaseV3(definition, runnerOptions(root, "deadline", plan, backend, ["ui.invoke"]));
  assert.equal(result.exitCode, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const writes = await readFile(marker, "utf8");
  assert.doesNotMatch(writes, /element\.action/u);
  assert.match(writes, /session\.terminate/u);
});

test("waitForWindow false is rejected before host spawn or wire submission", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "surfaceloom-windows-v3-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "spawn.log");
  assert.throws(() => createWindowsNativeSurfaceBackend({ hostId: "windows-scripted",
    process: { executable: process.execPath, cwd: path.dirname(fixture),
      argv: [fixture, "startup-marker", marker] },
    targets: { app: { kind: "launch", options: {
      executablePath: target, waitForWindow: false,
    } as never } },
  }), /waitForWindow:false is unsupported/u);
  await assert.rejects(readFile(marker, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

function cleanupFailureFixture(root: string, mode: "bad-end-proof" | "inherited-stdio") {
  const spec = { id: `windows.v3.cleanup.${mode}`, locale: "en-US", platforms: ["windows"] as const,
    suite: { id: "windows.v3.cleanup", name: "Windows cleanup contract" },
    name: "Cleanup failure publishes an honest red report",
    intent: "An incomplete target or host cleanup proof publishes a failed report and completion marker.", preconditions: [],
    acceptanceCriteria: [{ id: "body", text: "主体查询已完成。" }], sideEffect: "writesLocal" as const };
  const definition = defineCaseV3({ spec, run: async (context: CaseContextV3) => {
    const surface = context.surface("desktop");
    if (surface.kind !== "native" || surface.platform !== "windows") throw new Error("Expected Windows surface.");
    await surface.perform({ kind: "find", locator: { backend: "uia", automationId: "fixture.name" } });
    await context.criterion("body", () => undefined);
  } });
  const plan = defineExecutionPlan({ spec, requirements: { host: { os: ["windows"] }, surfaces: {
    desktop: { kind: "desktop", capabilities: ["ui.inspect"] },
  } }, effects: [
    { resource: "native.app.launch", operation: "execute", boundary: "local",
      securitySensitive: false, recovery: "unknown" },
    { resource: "native.ui.inspect", operation: "read", boundary: "local",
      securitySensitive: false, recovery: "notNeeded" },
  ] });
  const backend = createWindowsNativeSurfaceBackend({ hostId: "windows-scripted",
    process: { executable: process.execPath, cwd: path.dirname(fixture), argv: [fixture, mode],
      closeGraceMs: 5, forceCloseMs: 20 }, environmentCapabilities: ["app.launch", "ui.inspect"],
    targets: { "fixture-app": { kind: "launch", options: { executablePath: target } } },
    cleanupSettleTimeoutMs: 100 });
  const options: RunCaseV3Options = { platform: "windows", runnerHostId: "runner-host",
    run: { id: `windows-v3-${mode}`, title: "Windows cleanup failure", app: {
      id: "fixture-app", name: "Fixture App",
    }, hosts: [{ id: "runner-host", os: "windows" }, { id: "windows-scripted", os: "windows" }] },
    surfaces: [{ kind: "native", backend, requirement: { kind: "native", surfaceId: "desktop",
      expectedHostId: "windows-scripted", platform: "windows", backend: "uia", acquisition: "launch",
      capabilities: ["ui.inspect"], target: "fixture-app" } }],
    execution: { plan, environment: { platform: "windows", host: { os: "windows" }, surfaces: {
      desktop: { kind: "desktop", capabilities: ["ui.inspect"] },
    } }, policy: { maximumSideEffect: "writesLocal", grants: [
      { resource: "native.app.launch", operations: ["execute"], boundaries: ["local"],
        allowUnknownRecovery: true },
      { resource: "native.ui.inspect", operations: ["read"], boundaries: ["local"] },
    ] }, timeoutMs: 3_000, cleanupTimeoutMs: 500 },
    stagingDirectory: path.join(root, "staging"), outputDirectory: path.join(root, "report") };
  return { definition, options };
}

function runnerOptions(root: string, suffix: string, plan: ReturnType<typeof defineExecutionPlan>,
  backend: ReturnType<typeof createWindowsNativeSurfaceBackend>, capabilities: readonly string[]): RunCaseV3Options {
  return { platform: "windows", runnerHostId: "runner-host",
    run: { id: `windows-v3-${suffix}`, title: `Windows ${suffix}`, app: {
      id: "fixture-app", name: "Fixture App",
    }, hosts: [{ id: "runner-host", os: "windows" }, { id: "windows-scripted", os: "windows" }] },
    surfaces: [{ kind: "native", backend, requirement: { kind: "native", surfaceId: "desktop",
      expectedHostId: "windows-scripted", platform: "windows", backend: "uia", acquisition: "launch",
      capabilities, target: "fixture-app" } }],
    execution: { plan, environment: { platform: "windows", host: { os: "windows" }, surfaces: {
      desktop: { kind: "desktop", capabilities },
    } }, policy: { maximumSideEffect: "writesLocal", grants: [
      { resource: "native.app.launch", operations: ["execute"], boundaries: ["local"],
        allowUnknownRecovery: true },
      { resource: "native.ui.invoke", operations: ["write"], boundaries: ["local"],
        allowUnknownRecovery: true },
    ] }, timeoutMs: 3_000, cleanupTimeoutMs: 1_000 },
    stagingDirectory: path.join(root, "staging"), outputDirectory: path.join(root, "report") };
}
