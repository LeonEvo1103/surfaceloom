import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defineFixture, type CaseSpec } from "@surfaceloom/core";

import { defineCaseV3 } from "../src/definition-v3.js";
import { defineExecutionPlan } from "../src/plan.js";
import { runCaseV3 } from "../src/runner-v3.js";
import type { CaseContextV3, RunCaseV3Options } from "../src/runner-v3-contracts.js";
import { RunCaseV3Error } from "../src/runner-v3-error.js";
import type { BrowserSurfaceBackendPort } from "../src/surfaces/contracts.js";

test("v3 keeps original, dependency, and worker fixture identities across concurrent executions",
  async (context) => {
    const root = await temporary(context);
    let workerSetups = 0;
    let rootSetups = 0;
    let teardowns = 0;
    const worker = defineFixture({ id: "v3.worker", scope: "worker" as const, setup: () => ({
      value: ++workerSetups, teardown: () => { teardowns += 1; },
    }) });
    const fixture = defineFixture({ id: "v3.fixture", dependencies: [worker], setup: (fixtureContext) => ({
      value: `${fixtureContext.get(worker)}:${++rootSetups}`,
      teardown: () => { teardowns += 1; },
    }) });
    const observed: string[] = [];
    const spec = caseSpec("runner.v3.fixtures");
    const definition = defineCaseV3({ spec, fixtures: [fixture], run: async (caseContext) => {
      observed.push(caseContext.fixture(fixture));
      await caseContext.criterion("verified", () => assert.ok(true));
    } });
    await Promise.all([
      runCaseV3(definition, options(path.join(root, "left"), spec, backend())),
      runCaseV3(definition, options(path.join(root, "right"), spec, backend())),
    ]);
    await runCaseV3(definition, options(path.join(root, "repeat"), spec, backend()));
    assert.equal(workerSetups, 3);
    assert.equal(rootSetups, 3);
    assert.equal(teardowns, 6);
    assert.deepEqual(observed.map((value) => Number(value.split(":")[0])).sort(), [1, 2, 3]);
    assert.deepEqual(observed.map((value) => Number(value.split(":")[1])).sort(), [1, 2, 3]);
  });

test("author evidence snapshots reject hostile envelopes without invoking hooks", async (context) => {
  const root = await temporary(context);
  let hooks = 0;
  const spec = caseSpec("runner.v3.hostile-evidence");
  const definition = defineCaseV3({ spec, run: async (caseContext) => {
    const getter = Object.defineProperty({}, "id", { enumerable: true,
      get: () => { hooks += 1; return "getter"; } });
    const proxy = new Proxy({}, { ownKeys: () => { hooks += 1; return []; } });
    const hostile = [getter, proxy, { id: "to-json", artifactId: "to-json",
      content: { kind: "probe", probeId: "to-json", resource: "case.result",
        outcome: "observed", toJSON: () => { hooks += 1; return {}; } } },
    { id: "authority", artifactId: "authority", content: probe("authority"),
      scope: { reportRunId: "forged" } }];
    for (const item of hostile) assert.throws(() => caseContext.evidence.submit(item as never));
    caseContext.evidence.submit({ id: "valid", artifactId: "valid", content: probe("valid") });
    await caseContext.criterion("verified", () => assert.ok(true));
  } });
  const result = await runCaseV3(definition, options(root, spec, backend()));
  assert.equal(result.exitCode, 0);
  assert.equal(hooks, 0);
});

test("runner metadata is immutable after its pre-await descriptor snapshot", async (context) => {
  const root = await temporary(context);
  const spec = caseSpec("runner.v3.metadata-snapshot");
  let configured!: RunCaseV3Options;
  const mutableBackend = backend(() => {
    (configured.run as { title: string }).title = "mutated title";
    (configured.run.hosts[1] as { id: string }).id = "mutated-host";
    const surface = configured.surfaces[0]!;
    if (surface.kind === "browser") {
      (surface.requirement as { surfaceId: string }).surfaceId = "mutated-surface";
      (surface.backend as { hostId: string }).hostId = "mutated-backend";
    }
  });
  const definition = defineCaseV3({ spec, run: async (caseContext) => {
    (configured.run.app as { name: string }).name = "mutated app";
    await caseContext.criterion("verified", () => assert.ok(true));
  } });
  configured = options(root, spec, mutableBackend);
  const result = await runCaseV3(definition, configured);
  assert.equal(result.bundle.report.run.title, "Runner v3 audit");
  assert.equal(result.bundle.report.run.app.name, "Audit App");
  assert.equal(result.bundle.report.run.surfaces.state, "known");
  if (result.bundle.report.run.surfaces.state === "known") {
    assert.equal(result.bundle.report.run.surfaces.value[0]!.id, "page");
    assert.deepEqual(result.bundle.report.run.surfaces.value[0]!.hostId,
      { state: "known", value: "browser-host" });
  }
});

test("hostile top-level options and pre-existing paths reject before acquisition", async (context) => {
  const root = await temporary(context);
  const spec = caseSpec("runner.v3.preflight");
  const definition = defineCaseV3({ spec, run: () => undefined });
  let launches = 0;
  const good = options(path.join(root, "good"), spec, backend(() => { launches += 1; }));
  let hooks = 0;
  const getter = Object.defineProperty({}, "run", { enumerable: true,
    get: () => { hooks += 1; return good.run; } });
  const proxy = new Proxy(good, { ownKeys: () => { hooks += 1; return []; } });
  const toJSON = { ...good, toJSON: () => { hooks += 1; return good; } };
  await assert.rejects(runCaseV3(definition, getter as RunCaseV3Options));
  await assert.rejects(runCaseV3(definition, proxy));
  await assert.rejects(runCaseV3(definition, toJSON as RunCaseV3Options));
  assert.equal(hooks, 0);
  for (const conflict of ["staging", "report"] as const) {
    const runRoot = path.join(root, conflict);
    const configured = options(runRoot, spec, backend(() => { launches += 1; }));
    await mkdir(conflict === "staging" ? configured.stagingDirectory : configured.outputDirectory,
      { recursive: true });
    await assert.rejects(runCaseV3(definition, configured), /already exists.*non-idempotent/u);
  }
  assert.equal(launches, 0);
});

test("kernel failures retain their first cause across no, partial, and completed acquisition",
  async (context) => {
    const root = await temporary(context);
    const fixtureFailure = new Error("fixture setup first");
    const brokenFixture = defineFixture({ id: "broken", setup: () => { throw fixtureFailure; } });
    const fixtureSpec = caseSpec("runner.v3.fixture-failure");
    const fixtureCase = defineCaseV3({ spec: fixtureSpec, fixtures: [brokenFixture], run: () => undefined });
    await assertEnvelope(runCaseV3(fixtureCase,
      options(path.join(root, "fixture"), fixtureSpec, backend())), "fixture setup first");

    const firstSpec = caseSpec("runner.v3.first-acquisition");
    const firstCase = defineCaseV3({ spec: firstSpec, run: () => undefined });
    await assertEnvelope(runCaseV3(firstCase, options(path.join(root, "first"), firstSpec,
      backend(undefined, new Error("first acquisition failed")))), "first acquisition failed");

    const bodySpec = caseSpec("runner.v3.body-failure");
    const bodyCase = defineCaseV3({ spec: bodySpec, run: () => { throw new Error("body first"); } });
    const body = await runCaseV3(bodyCase, options(path.join(root, "body"), bodySpec, backend()));
    assert.equal(body.exitCode, 1);
    assert.equal(finalError(body.bundle.report.tests[0]!.attempts), "body first");

    const partialSpec = caseSpec("runner.v3.partial-acquisition");
    const partialCase = defineCaseV3({ spec: partialSpec, run: () => undefined });
    const partialOptions = options(path.join(root, "partial"), partialSpec, backend(), 2);
    const second = partialOptions.surfaces[1]!;
    if (second.kind !== "browser") throw new Error("Expected browser config.");
    (partialOptions.surfaces as RunnerSurfaceMutable[])[1] = {
      ...second, backend: backend(undefined, new Error("second acquisition failed")),
    };
    const partial = await runCaseV3(partialCase, partialOptions);
    assert.equal(partial.exitCode, 1);
    assert.equal(finalError(partial.bundle.report.tests[0]!.attempts), "second acquisition failed");
  });

test("evidence, materialization, and publication failures are additive to the body cause",
  async (context) => {
    const root = await temporary(context);
    const requiredSpec = caseSpec("runner.v3.required-additive");
    const requiredCase = defineCaseV3({ spec: requiredSpec,
      run: () => { throw new Error("required body first"); } });
    const requiredOptions = options(path.join(root, "required"), requiredSpec, backend());
    (requiredOptions as MutableOptions).requiredEvidence = [
      { artifactId: "missing", requireComplete: true },
    ];
    await assertEnvelope(runCaseV3(requiredCase, requiredOptions), "required body first", "adaptation");

    const materialSpec = caseSpec("runner.v3.materialize-additive");
    const materialRoot = path.join(root, "materialize");
    const materialOptions = options(materialRoot, materialSpec, backend());
    const materialCase = defineCaseV3({ spec: materialSpec, run: async () => {
      await mkdir(materialOptions.stagingDirectory, { recursive: true });
      await writeFile(path.join(materialOptions.stagingDirectory, "0001-surface.page.1.json"), "conflict");
      throw new Error("material body first");
    } });
    await assertEnvelope(runCaseV3(materialCase, materialOptions), "material body first", "materialization");

    const publicationSpec = caseSpec("runner.v3.publication-additive");
    const publicationRoot = path.join(root, "publication");
    const publicationOptions = options(publicationRoot, publicationSpec, backend());
    const publicationCase = defineCaseV3({ spec: publicationSpec, run: async () => {
      await mkdir(publicationOptions.outputDirectory, { recursive: true });
      throw new Error("publication body first");
    } });
    await assertEnvelope(runCaseV3(publicationCase, publicationOptions),
      "publication body first", "publication");
    await assert.rejects(stat(path.join(publicationOptions.outputDirectory, "complete.json")),
      { code: "ENOENT" });
  });

test("pre-abort and a noncooperative producer never acquire or publish a complete bundle",
  async (context) => {
    const root = await temporary(context);
    const spec = caseSpec("runner.v3.stop-gate");
    let launches = 0;
    const preAbort = new AbortController();
    preAbort.abort();
    const preOptions = options(path.join(root, "pre"), spec, backend(() => { launches += 1; }));
    (preOptions.execution as { signal?: AbortSignal }).signal = preAbort.signal;
    const definition = defineCaseV3({ spec, run: () => undefined });
    await assert.rejects(runCaseV3(definition, preOptions), (error: unknown) =>
      error instanceof RunCaseV3Error && error.additionalFailure.phase === "kernelStop");
    assert.equal(launches, 0);

    const hangingOptions = options(path.join(root, "hang"), spec, backend());
    (hangingOptions.execution as { timeoutMs: number }).timeoutMs = 5;
    const hanging = defineCaseV3({ spec, run: () => new Promise<void>(() => undefined) });
    await assert.rejects(runCaseV3(hanging, hangingOptions), (error: unknown) =>
      error instanceof RunCaseV3Error && error.additionalFailure.phase === "kernelStop"
        && error.report.result.status === "timedOut");
    await assert.rejects(stat(path.join(hangingOptions.outputDirectory, "complete.json")),
      { code: "ENOENT" });
  });

type RunnerSurfaceMutable = RunCaseV3Options["surfaces"][number];
type MutableOptions = RunCaseV3Options & { requiredEvidence: RunCaseV3Options["requiredEvidence"] };

function options(root: string, spec: CaseSpec, browser: BrowserSurfaceBackendPort,
  surfaceCount = 1): RunCaseV3Options {
  const surfaces = Array.from({ length: surfaceCount }, (_unused, index) => ({
    kind: "browser" as const,
    backend: browser,
    requirement: { kind: "browser" as const, surfaceId: index === 0 ? "page" : `page-${index + 1}`,
      expectedHostId: "browser-host", capabilities: ["browser.dom.inspect"],
      engine: "chromium" as const },
  }));
  const requirements = Object.fromEntries(surfaces.map((surface) => [surface.requirement.surfaceId,
    { kind: "browser" as const, capabilities: ["browser.dom.inspect" as const] }]));
  return {
    platform: "web",
    runnerHostId: "runner-host",
    run: { id: `run-${spec.id}`, title: "Runner v3 audit",
      app: { id: "audit-app", name: "Audit App" }, hosts: [
        { id: "runner-host", os: "linux" }, { id: "browser-host", os: "linux" },
      ] },
    surfaces,
    execution: {
      plan: defineExecutionPlan({ spec, requirements: { surfaces: requirements }, effects: [{
        resource: "browser.session", operation: "execute", boundary: "local",
        securitySensitive: false, recovery: "unknown",
      }] }),
      environment: { platform: "web", host: { os: "linux" }, surfaces: requirements },
      policy: { maximumSideEffect: "writesLocal", grants: [{ resource: "browser.session",
        operations: ["execute"], boundaries: ["local"], allowUnknownRecovery: true }] },
      timeoutMs: 1_000,
      cleanupTimeoutMs: 100,
    },
    stagingDirectory: path.join(root, "staging"),
    outputDirectory: path.join(root, "report"),
  };
}

function backend(beforeLaunch?: () => void, failure?: Error): BrowserSurfaceBackendPort {
  return { hostId: "browser-host", capabilities: ["browser.dom.inspect"],
    launch: async (_requirement, call) => {
      call.beforeSubmit();
      beforeLaunch?.();
      if (failure !== undefined) throw failure;
      return { identity: { hostId: "browser-host", sessionId: "session" },
        invoke: async (_action, operation) => { operation.beforeSubmit(); return null; },
        close: async () => ({ kind: "browserSessionClosed", hostId: "browser-host",
          sessionId: "session" }) };
    } };
}

function caseSpec(id: string): CaseSpec {
  return { id, locale: "en-US", platforms: ["web"], suite: { id: "runner.v3", name: "Runner v3" },
    name: "Runner v3 audit", intent: "Audit runner-owned v3 lifecycle contracts.", preconditions: [],
    acceptanceCriteria: [{ id: "verified", text: "The observation is verified." }],
    sideEffect: "writesLocal" };
}

function probe(id: string) {
  return { kind: "probe" as const, probeId: id, resource: "case.result",
    outcome: "observed" as const, value: { ok: true } };
}

async function assertEnvelope(promise: Promise<unknown>, primary: string,
  phase?: RunCaseV3Error["additionalFailure"]["phase"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    if (!(error instanceof RunCaseV3Error)) return false;
    assert.equal(Object.isFrozen(error), true);
    assert.equal(Object.isFrozen(error.report), true);
    assert.equal(Object.isFrozen(error.report.result), true);
    assert.equal(Object.isFrozen(error.additionalFailure), true);
    return error.primaryCause?.message === primary
      && (phase === undefined || error.additionalFailure.phase === phase);
  });
}

function finalError(attempts: { readonly state: string; readonly items?: readonly {
  readonly result: { readonly error?: { readonly message: string } } }[] }): string | undefined {
  return attempts.items?.at(-1)?.result.error?.message;
}

async function temporary(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runner-v3-audit-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
