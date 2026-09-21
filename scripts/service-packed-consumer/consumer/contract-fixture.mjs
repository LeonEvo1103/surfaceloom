import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  CommandExecutor, SurfaceLoomV3Executor, validateTestDefinition,
} from "@surfaceloom/service";
import {
  defineCaseV3, defineExecutionPlan,
} from "@surfaceloom/test";

const execute = promisify(execFile);
export const executorId = "packed.consumer";
export const cliTestId = "service-test:packed/cli";
export const cancelTestId = "service-test:packed/cancel";
export const uncleanTestId = "service-test:packed/unclean";
export const v3TestId = "service-test:packed/v3";
export const v3CaseId = "packed.consumer.v3";

export class RoutingExecutor {
  id = executorId;
  #command;
  #v3;
  #routes = new Map();
  counts = new Map();

  constructor({ artifactStore, counterPath, workRoot }) {
    const processTree = { launch(spawn, executable, argv, options) {
      const child = spawn(executable, argv, options);
      return { child, handle: { cleanup: async () => child.exitCode !== null
        || child.signalCode !== null ? { status: "confirmed" }
        : { status: "unconfirmed", detail: "Fixture process has not exited." } } };
    } };
    this.#command = new CommandExecutor(executorId, {
      commands: [
        command(cliTestId, "pass.mjs", 2_000),
        command(cancelTestId, "wait.mjs", 10_000),
      ],
      allowedCwds: ["."], allowedEnvironment: ["SL_CONFORMANCE_COUNTER"],
      environment: { SL_CONFORMANCE_COUNTER: counterPath }, processTree,
      terminateGraceMs: 100, forceKillWaitMs: 1_000,
    });
    this.#v3 = new SurfaceLoomV3Executor(executorId, {
      artifactStore, workRoot, registrations: [v3Registration()],
    });
  }

  execute(request, signal) {
    this.counts.set(request.testId, (this.counts.get(request.testId) ?? 0) + 1);
    const target = request.testId === v3TestId ? this.#v3
      : request.testId === uncleanTestId ? uncleanExecutor : this.#command;
    this.#routes.set(request.runId, target);
    return target.execute(request, signal);
  }

  cancel(request, signal) {
    return this.#routes.get(request.runId)?.cancel(request, signal)
      ?? Promise.resolve({ runId: request.runId, disposition: "not-found" });
  }

  cleanup(request, signal) {
    return this.#routes.get(request.runId)?.cleanup(request, signal)
      ?? Promise.resolve(cleanup(request, "not-required"));
  }
}

export class RecordingProvider {
  constructor(delegate) { this.delegate = delegate; this.snapshots = new Map(); }
  get id() { return this.delegate.id; }
  getOperation(id) { return this.delegate.getOperation(id); }
  async prepare(request, signal) {
    const snapshot = await this.delegate.prepare(request, signal);
    this.snapshots.set(snapshot.snapshotId, snapshot);
    return snapshot;
  }
  acquireLease(snapshot, runId) { return this.delegate.acquireLease(snapshot, runId); }
  completeLease(lease, receipt) { return this.delegate.completeLease(lease, receipt); }
  release(snapshot, signal) { return this.delegate.release(snapshot, signal); }
}

export async function createRepository(root) {
  const sourceRoot = path.join(root, "sources");
  const repository = path.join(sourceRoot, "repository");
  await mkdir(repository, { recursive: true });
  await writeFile(path.join(repository, "pass.mjs"), [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.SL_CONFORMANCE_COUNTER, 'once\\n');",
    "process.stdout.write('packed-cli-ok');",
  ].join("\n"));
  await writeFile(path.join(repository, "wait.mjs"),
    "process.stdout.write('ready\\n'); setInterval(() => undefined, 1000);\n");
  await git(repository, ["init"]);
  await git(repository, ["config", "user.name", "SurfaceLoom Conformance"]);
  await git(repository, ["config", "user.email", "conformance@invalid.example"]);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "fixture"]);
  const revision = (await git(repository, ["rev-parse", "HEAD"])).trim();
  return { sourceRoot, repository, revision, snapshotRoot: path.join(root, "snapshots") };
}

export function definitions() {
  return [
    definition(cliTestId, "cli", "writesLocal"),
    definition(cancelTestId, "cli", "readOnly"),
    definition(uncleanTestId, "node", "writesLocal"),
    definition(v3TestId, "surfaceloom-v3", "writesLocal", [{ id: v3CaseId }], [
      { name: "report.json", mediaType: "application/json", required: true },
      { name: "index.html", mediaType: "text/html", required: true },
      { name: "ai-review.md", mediaType: "text/markdown", required: true },
      { name: "complete.json", mediaType: "application/json", required: true },
    ]),
  ].map(validateTestDefinition);
}

export async function assertPackedResolution(consumerRoot, repositoryRoot) {
  const canonicalConsumerModules = `${await realpath(path.join(consumerRoot, "node_modules"))}${path.sep}`;
  const canonicalRepository = `${await realpath(repositoryRoot)}${path.sep}`;
  for (const name of ["@surfaceloom/core", "@surfaceloom/llm-judge", "@surfaceloom/reporter",
    "@surfaceloom/test", "@surfaceloom/service"]) {
    const resolved = await realpath(fileURLToPath(import.meta.resolve(name)));
    assert.ok(resolved.startsWith(canonicalConsumerModules), resolved);
    assert.ok(!resolved.startsWith(canonicalRepository), resolved);
  }
}

function command(testId, file, timeoutMs) {
  return { testId, executorId, executable: process.execPath, argv: [file], cwd: ".",
    inheritEnvironment: ["SL_CONFORMANCE_COUNTER"], timeoutMs,
    exitCodes: { passed: [0], failed: [1] } };
}

function definition(testId, kind, effect, caseSpecs = [], artifacts = []) {
  return { schemaVersion: 1, testId, title: `Packed consumer ${kind}`,
    description: "External packed-consumer conformance task.", caseSpecs,
    coverage: { includes: ["packed-consumer"], exclusions: [] },
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    runtime: { executorId, kind }, effect,
    requirements: { platforms: ["darwin", "linux", "win32"], capabilities: [kind], environment: [] },
    output: { resultFormat: "surfaceloom.run-result/v1", artifacts } };
}

function v3Registration() {
  const spec = { id: v3CaseId, locale: "en-US", platforms: ["web"],
    suite: { id: "packed.consumer", name: "Packed consumer" }, name: "Packed v3 Case",
    intent: "Prove that the installed service invokes the public v3 kernel.", preconditions: [],
    acceptanceCriteria: [{ id: "status", text: "The neutral surface returns ready." }],
    sideEffect: "writesLocal" };
  const definition = defineCaseV3({ spec, run: async (context) => {
    const surface = context.surface("page");
    assert.equal(surface.kind, "browser");
    const value = await surface.perform({ kind: "readText",
      locator: { kind: "testId", key: "testId", value: "status" } });
    await context.criterion("status", () => assert.equal(value, "ready"));
  } });
  const surfaces = { page: { kind: "browser", capabilities: ["browser.dom.inspect"] } };
  const plan = defineExecutionPlan({ spec, requirements: { host: { os: ["linux"] }, surfaces },
    effects: [
      { resource: "browser.session", operation: "execute", boundary: "local",
        securitySensitive: false, recovery: "unknown" },
      { resource: "browser.readText", operation: "read", boundary: "local",
        securitySensitive: false, recovery: "notNeeded" },
    ] });
  const backend = { hostId: "neutral-host", capabilities: ["browser.dom.inspect"],
    async launch(_requirement, call) {
      call.beforeSubmit();
      return { identity: { hostId: "neutral-host", sessionId: "neutral-session" },
        async invoke(_action, operation) { operation.beforeSubmit(); return "ready"; },
        async close() { return { kind: "browserSessionClosed", hostId: "neutral-host",
          sessionId: "neutral-session" }; } };
    } };
  const options = { platform: "web", runnerHostId: "runner-host",
    run: { title: "Packed consumer v3", app: { id: "neutral", name: "Neutral fixture" },
      hosts: [{ id: "runner-host", os: "linux" }, { id: "neutral-host", os: "linux" }] },
    surfaces: [{ kind: "browser", backend, requirement: { kind: "browser", surfaceId: "page",
      expectedHostId: "neutral-host", capabilities: ["browser.dom.inspect"], engine: "chromium" } }],
    execution: { plan, environment: { platform: "web", host: { os: "linux" }, surfaces },
      policy: { maximumSideEffect: "writesLocal", grants: [
        { resource: "browser.session", operations: ["execute"], boundaries: ["local"],
          allowUnknownRecovery: true },
        { resource: "browser.readText", operations: ["read"], boundaries: ["local"] },
      ] }, timeoutMs: 2_000, cleanupTimeoutMs: 300 } };
  return { testId: v3TestId, caseSpecId: v3CaseId,
    resolve: () => ({ definition, options }) };
}

const uncleanExecutor = {
  async execute(request) {
    return { runId: request.runId, snapshot: request.snapshot, testId: request.testId,
      parameters: request.parameters, startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(), artifacts: [],
      cleanup: cleanup(request, "unconfirmed"), executionStatus: "completed", outcome: "passed" };
  },
  async cancel(request) { return { runId: request.runId, disposition: "already-terminal" }; },
  async cleanup(request) { return cleanup(request, "unconfirmed"); },
};

function cleanup(request, status) {
  return { runId: request.runId, snapshotId: request.snapshot.snapshotId, status,
    tainted: status === "unconfirmed", attemptedAt: new Date().toISOString(),
    ...(status === "unconfirmed" ? { detail: "Injected cleanup proof loss." } : {}) };
}

async function git(cwd, args) {
  const result = await execute("git", args, { cwd, windowsHide: true });
  return result.stdout;
}
