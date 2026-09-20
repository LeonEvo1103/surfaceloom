import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeJudgeProvider } from "@surfaceloom/llm-judge";
import { RequiredArtifactPublicationError } from "@surfaceloom/reporter";
import { defineCaseV3 } from "../../src/definition-v3.js";
import { defineExecutionPlan } from "../../src/plan.js";
import { RunnerExecutionAuthority } from "../../src/evidence/execution-scope.js";
import { ImageEvidenceCollectorV3 } from "../../src/judge/image-evidence.js";
import { RunCaseV3Error } from "../../src/runner-v3-error.js";
import { prepareCaseV3, publishPreparedCaseV3, runCaseV3 } from "../../src/runner-v3.js";
import type { RunCaseV3Options } from "../../src/runner-v3-contracts.js";
import type { BrowserSurfaceBackendPort } from "../../src/surfaces/contracts.js";

const passOutcome = () => ({ status: "classified", label: "sign-in", confidence: 0.9,
  reasons: ["The page shows the sign-in route."],
  evidenceRefs: ["judge.route.evidence.1"], observedFacts: [{ kind: "observed",
    scope: "ui", statement: "The heading shows sign in.",
    evidenceRefs: ["judge.route.evidence.1"] }], hypotheses: [],
  providerMetadata: { provider: "forged", model: "forged" } });

test("explicit Judge criterion binds only current materialized evidence and publishes correlation",
  async (context) => {
    const root = await temporary(context);
    const provider = new FakeJudgeProvider([{ kind: "return", output: passOutcome() }]);
    const fixture = judgeFixture(root, provider);
    const result = await runCaseV3(fixture.definition, fixture.options);
    assert.equal(result.exitCode, 0);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0]!.serviceRunId, "report-run-1");
    assert.deepEqual(provider.calls[0]!.evidence.map((item) => [item.evidenceId,
      item.origin.artifactId]), [["judge.route.evidence.1", "page-state"]]);
    const attempts = result.bundle.report.tests[0]!.attempts;
    assert.equal(attempts.state, "known");
    if (attempts.state !== "known") return;
    const final = attempts.items[0]!.result;
    assert.equal(final.status, "passed");
    const artifact = final.artifacts.find((item) => item.id === "judge.route.result");
    assert.deepEqual(artifact?.relatedArtifactIds, ["page-state"]);
    assert.equal(artifact?.captureStatus, "captured");
    if (artifact?.relativePath === undefined) throw new Error("Judge result was not published.");
    const record = JSON.parse(await readFile(path.join(result.bundle.directory,
      artifact.relativePath), "utf8")) as Record<string, any>;
    assert.equal(record.binding.reportRunId, "report-run-1");
    assert.equal(record.binding.attemptId, "attempt-1");
    assert.equal(record.correlationId, `judge.${record.binding.caseExecutionId}.attempt-1.route`);
    assert.deepEqual(record.evidence, [{ evidenceId: "judge.route.evidence.1",
      artifactId: "page-state" }]);
  });

test("a passing Judge never overwrites a deterministic failure", async (context) => {
  const root = await temporary(context);
  const provider = new FakeJudgeProvider([{ kind: "return", output: passOutcome() }]);
  const fixture = judgeFixture(root, provider, { deterministicFailure: true });
  const result = await runCaseV3(fixture.definition, fixture.options);
  assert.equal(result.exitCode, 1);
  const attempts = result.bundle.report.tests[0]!.attempts;
  if (attempts.state !== "known") throw new Error("Expected known attempt.");
  assert.equal(attempts.items[0]!.result.status, "failed");
  assert.notEqual(attempts.items[0]!.result.error?.category, "judge");
  assert.match(attempts.items[0]!.result.error?.message ?? "", /deterministic/u);
  assert.equal(provider.calls.length, 1);
});

test("insufficient, provider failure, missing provider, deadline, and abort fail conservatively",
  async (context) => {
    const scenarios = [
      { name: "insufficient", provider: new FakeJudgeProvider([{ kind: "return", output: {
        status: "insufficient", reason: "Heading is missing.", reasons: ["No heading."],
        evidenceRefs: ["judge.route.evidence.1"], observedFacts: [], hypotheses: [],
        providerMetadata: { provider: "fake", model: "fake" },
      } }]) },
      { name: "provider", provider: new FakeJudgeProvider([{ kind: "throw",
        failureKind: "server", message: "secret upstream", retryable: true }]) },
      { name: "missing", provider: undefined },
      { name: "deadline", provider: new FakeJudgeProvider([{ kind: "return", output: passOutcome() }]),
        deadlineAt: 0 },
      { name: "abort", provider: new FakeJudgeProvider([{ kind: "return", output: passOutcome() }]),
        aborted: true },
    ] as const;
    for (const scenario of scenarios) {
      const root = await mkdtemp(path.join(os.tmpdir(), `judge-${scenario.name}-`));
      context.after(() => rm(root, { recursive: true, force: true }));
      const fixture = judgeFixture(root, scenario.provider, { deadlineAt: scenario.deadlineAt,
        aborted: scenario.aborted });
      const result = await runCaseV3(fixture.definition, fixture.options);
      assert.equal(result.exitCode, 1, scenario.name);
      const attempts = result.bundle.report.tests[0]!.attempts;
      if (attempts.state !== "known") throw new Error("Expected known attempt.");
      assert.equal(attempts.items[0]!.result.error?.category, "judge", scenario.name);
      assert.match(attempts.items[0]!.result.error?.message ?? "", /Judge/u, scenario.name);
    }
  });

test("provider output cannot forge artifact, correlation, or execution identity", async (context) => {
  const root = await temporary(context);
  const forged = { ...passOutcome(), artifactId: "foreign", correlationId: "foreign",
    reportRunId: "foreign" };
  const provider = new FakeJudgeProvider([{ kind: "return", output: forged }]);
  const fixture = judgeFixture(root, provider);
  const result = await runCaseV3(fixture.definition, fixture.options);
  assert.equal(result.exitCode, 1);
  const attempts = result.bundle.report.tests[0]!.attempts;
  if (attempts.state !== "known") throw new Error("Expected known attempt.");
  const artifact = attempts.items[0]!.result.artifacts.find((item) =>
    item.id === "judge.route.result");
  assert.deepEqual(artifact?.relatedArtifactIds, ["page-state"]);
});

test("cross-attempt-like refs and duplicate result artifact ids fail before provider execution",
  async (context) => {
    for (const behavior of [{ evidenceArtifactId: "foreign-attempt" },
      { authorArtifactId: "judge.route.result" }]) {
      const root = await mkdtemp(path.join(os.tmpdir(), "judge-scope-"));
      context.after(() => rm(root, { recursive: true, force: true }));
      const provider = new FakeJudgeProvider([{ kind: "return", output: passOutcome() }]);
      const fixture = judgeFixture(root, provider, behavior);
      await assert.rejects(runCaseV3(fixture.definition, fixture.options),
        (error: unknown) => error instanceof RunCaseV3Error
          && /outside its current attempt|collides/u.test(error.message));
      assert.equal(provider.calls.length, 0);
    }
  });

test("Judge declarations reject getters, Proxy values, duplicate ids, and unknown criteria", () => {
  let reads = 0;
  const getter = baseDefinitionInput() as Record<string, unknown>;
  Object.defineProperty(getter, "judgeCriteria", { enumerable: true,
    get() { reads += 1; return []; } });
  assert.throws(() => defineCaseV3(getter as never), /data field/);
  assert.equal(reads, 0);
  let traps = 0;
  const proxyCriteria = new Proxy([criterion()], {
    ownKeys() { traps += 1; throw new Error("executed"); },
  });
  assert.throws(() => defineCaseV3({ ...baseDefinitionInput(), judgeCriteria: proxyCriteria }),
    /plain array/);
  assert.equal(traps, 0);
  assert.throws(() => defineCaseV3({ ...baseDefinitionInput(),
    judgeCriteria: [criterion(), criterion()] }), /duplicate/);
  assert.throws(() => defineCaseV3({ ...baseDefinitionInput(),
    judgeCriteria: [{ ...criterion(), criterionId: "unknown" }] }), /unknown acceptance/);
});

test("Judge runner binding rejects accessors and provider Proxy traps before execution",
  async (context) => {
    const root = await temporary(context);
    const provider = new FakeJudgeProvider([{ kind: "return", output: passOutcome() }]);
    const fixture = judgeFixture(root, provider);
    const binding = { ...fixture.options.judge! } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(binding, "deadlineAt", { enumerable: true,
      get() { reads += 1; return Date.now() + 1_000; } });
    await assert.rejects(runCaseV3(fixture.definition,
      { ...fixture.options, judge: binding as never }), /data field/);
    assert.equal(reads, 0);
    assert.equal(provider.calls.length, 0);

    let traps = 0;
    const proxy = new Proxy(provider, { get() { traps += 1; throw new Error("executed"); },
      ownKeys() { traps += 1; throw new Error("executed"); } });
    await assert.rejects(runCaseV3(fixture.definition, { ...fixture.options,
      judge: { ...fixture.options.judge!, provider: proxy } }), /non-Proxy/);
    assert.equal(traps, 0);
  });

test("incomplete selected evidence skips the provider and fails as insufficient", async (context) => {
  const root = await temporary(context);
  const provider = new FakeJudgeProvider([{ kind: "return", output: passOutcome() }]);
  const fixture = judgeFixture(root, provider, { incomplete: true });
  const result = await runCaseV3(fixture.definition, fixture.options);
  assert.equal(result.exitCode, 1);
  assert.equal(provider.calls.length, 0);
  const attempts = result.bundle.report.tests[0]!.attempts;
  if (attempts.state !== "known") throw new Error("Expected known attempt.");
  const artifact = attempts.items[0]!.result.artifacts.find((item) => item.id === "judge.route.result");
  if (artifact?.relativePath === undefined) throw new Error("Expected Judge result artifact.");
  const record = JSON.parse(await readFile(path.join(result.bundle.directory,
    artifact.relativePath), "utf8")) as { outcome: { status: string } };
  assert.equal(record.outcome.status, "insufficient");
});

test("Judge inherits the Case deadline and optional cancellation signal", async (context) => {
  for (const mode of ["deadline", "signal"] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), `judge-${mode}-`));
    context.after(() => rm(root, { recursive: true, force: true }));
    const provider = new FakeJudgeProvider([{ kind: "waitForAbort" }]);
    const fixture = judgeFixture(root, provider, { omitJudgeDeadline: true,
      executionTimeoutMs: mode === "deadline" ? 200 : 2_000 });
    if (mode === "signal") {
      const controller = new AbortController();
      fixture.options = { ...fixture.options,
        judge: { provider, signal: controller.signal } };
      setTimeout(() => controller.abort(), 20);
    }
    const started = Date.now();
    const result = await runCaseV3(fixture.definition, fixture.options);
    assert.equal(result.exitCode, 1);
    assert.ok(Date.now() - started < 1_000, `${mode} did not bound Judge`);
    assert.equal(provider.calls.length, 1);
  }
});

test("PNG, JPEG, and WebP bytes use image descriptors bound to this attempt", async (context) => {
  const samples = [
    ["image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])],
    ["image/webp", Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])],
  ] as const;
  for (const [mediaType, bytes] of samples) {
    const root = await mkdtemp(path.join(os.tmpdir(), "judge-image-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const provider = new FakeJudgeProvider([{ kind: "return", output: passOutcome() }]);
    const fixture = judgeFixture(root, provider, { evidenceArtifactId: "screen",
      image: { mediaType, bytes } });
    const result = await runCaseV3(fixture.definition, { ...fixture.options,
      evidencePolicy: { screenshots: "off", logs: "off" } });
    assert.equal(result.exitCode, 0, mediaType);
    assert.equal(provider.calls[0]!.evidence[0]!.kind, "image");
    const descriptor = provider.calls[0]!.evidence[0]!;
    if (descriptor.kind !== "image") throw new Error("Expected image descriptor.");
    assert.equal(descriptor.mediaType, mediaType);
    assert.equal(descriptor.byteLength, bytes.byteLength);
    const attempts = result.bundle.report.tests[0]!.attempts;
    if (attempts.state !== "known") throw new Error("Expected known attempt.");
    assert.ok(attempts.items[0]!.result.artifacts.some((item) => item.id === "screen"));
  }
});

test("Judge-required evidence survives logs off and missing staged result blocks publication",
  async (context) => {
    const retainedRoot = await mkdtemp(path.join(os.tmpdir(), "judge-required-retained-"));
    context.after(() => rm(retainedRoot, { recursive: true, force: true }));
    const retainedProvider = new FakeJudgeProvider([{ kind: "return", output: passOutcome() }]);
    const retainedFixture = judgeFixture(retainedRoot, retainedProvider);
    const retained = await runCaseV3(retainedFixture.definition, { ...retainedFixture.options,
      evidencePolicy: { logs: "off" } });
    const retainedAttempts = retained.bundle.report.tests[0]!.attempts;
    if (retainedAttempts.state !== "known") throw new Error("Expected known attempt.");
    const retainedIds = new Set(retainedAttempts.items[0]!.result.artifacts.map((item) => item.id));
    assert.ok(retainedIds.has("page-state"));
    assert.ok(retainedIds.has("judge.route.result"));

    const root = await temporary(context);
    const provider = new FakeJudgeProvider([{ kind: "return", output: passOutcome() }]);
    const fixture = judgeFixture(root, provider);
    const prepared = await prepareCaseV3(fixture.definition, { ...fixture.options,
      evidencePolicy: { logs: "off" } });
    assert.deepEqual(new Set(prepared.requiredArtifacts.map((item) => item.artifactId)),
      new Set(["page-state", "judge.route.result"]));
    const attempts = prepared.input.tests[0]!.attempts;
    if (attempts.state !== "known") throw new Error("Expected known attempt.");
    const resultArtifact = attempts.items[0]!.result.artifacts?.find((item) =>
      item.id === "judge.route.result");
    if (resultArtifact?.sourcePath === undefined) throw new Error("Expected staged Judge result.");
    await unlink(resultArtifact.sourcePath);
    await assert.rejects(publishPreparedCaseV3(prepared, fixture.options.outputDirectory,
      { logs: "off" }), (error: unknown) => error instanceof RequiredArtifactPublicationError
        && error.failures.some((failure) => failure.artifactId === "judge.route.result"));
  });

test("image evidence rejects getters, Proxy traps, paths, malformed bytes, and duplicates", () => {
  const scope = new RunnerExecutionAuthority({ reportRunId: "image-run",
    runnerHostId: "runner-host" }).issue({ caseExecutionId: "case-image",
    attemptId: "attempt-1", ordinal: 1 });
  const collector = new ImageEvidenceCollectorV3(scope);
  let reads = 0;
  const getter = { id: "getter", artifactId: "getter", mediaType: "image/png" } as
    Record<string, unknown>;
  Object.defineProperty(getter, "bytes", { enumerable: true,
    get() { reads += 1; return Uint8Array.from([0x89]); } });
  assert.throws(() => collector.submit(getter as never), /data field/);
  assert.equal(reads, 0);
  const nestedGetter = { id: "nested", artifactId: "nested", mediaType: "image/png", bytes:
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    completeness: Object.defineProperty({}, "state", { enumerable: true,
      get() { reads += 1; return "complete"; } }) };
  assert.throws(() => collector.submit(nestedGetter as never), /JSON data field/);
  assert.equal(reads, 0);
  let traps = 0;
  const proxy = new Proxy({}, { ownKeys() { traps += 1; throw new Error("executed"); } });
  assert.throws(() => collector.submit(proxy as never), /plain data object/);
  assert.equal(traps, 0);
  assert.throws(() => collector.submit({ id: "url", artifactId: "url", mediaType: "image/png",
    bytes: Uint8Array.from([0x89]), url: "https://example.invalid/x.png" } as never),
  /unknown metadata/);
  assert.throws(() => collector.submit({ id: "bad", artifactId: "bad", mediaType: "image/png",
    bytes: Uint8Array.from([0x89, 0x50]) }), /do not match/);
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  collector.submit({ id: "one", artifactId: "screen", mediaType: "image/png", bytes: png });
  assert.throws(() => collector.submit({ id: "one", artifactId: "screen-2",
    mediaType: "image/png", bytes: png }), /Duplicate image evidence submission id/);
  assert.throws(() => collector.submit({ id: "two", artifactId: "screen",
    mediaType: "image/png", bytes: png }), /Duplicate image evidence artifact id/);
});

function judgeFixture(root: string, provider: FakeJudgeProvider | undefined, behavior: {
  readonly deterministicFailure?: boolean;
  readonly evidenceArtifactId?: string;
  readonly authorArtifactId?: string;
  readonly deadlineAt?: number;
  readonly aborted?: boolean;
  readonly incomplete?: boolean;
  readonly omitJudgeDeadline?: boolean;
  readonly executionTimeoutMs?: number;
  readonly image?: { readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
    readonly bytes: Uint8Array };
} = {}) {
  const browser: BrowserSurfaceBackendPort = { hostId: "browser-host",
    capabilities: ["browser.dom.inspect"], launch: async (_requirement, call) => {
      call.beforeSubmit();
      return { identity: { hostId: "browser-host", sessionId: "session-1" },
        invoke: async () => "Sign in", close: async () => ({ kind: "browserSessionClosed",
          hostId: "browser-host", sessionId: "session-1" }) };
    } };
  const spec = caseSpec();
  const definition = defineCaseV3({ spec,
    judgeCriteria: [criterion(behavior.evidenceArtifactId)],
    run: async (caseContext) => {
      caseContext.evidence.submit({ id: "page-state", artifactId:
        behavior.authorArtifactId ?? "page-state", content: { kind: "probe",
        probeId: "page-state", resource: "page.route", outcome: "observed",
        value: { heading: "Sign in" } }, ...(behavior.incomplete ? {
          completeness: { state: "incomplete", reasons: ["producerDeclaredIncomplete"] },
        } : {}) });
      if (behavior.image !== undefined) caseContext.evidence.submitImage({ id: "screen",
        artifactId: "screen", mediaType: behavior.image.mediaType, bytes: behavior.image.bytes });
      if (behavior.deterministicFailure) {
        await caseContext.step({ id: "deterministic", title: "确定性断言",
          criterionIds: ["deterministic"] }, () => { throw new Error("deterministic failed"); });
      } else {
        await caseContext.criterion("deterministic", () => assert.ok(true));
      }
    } });
  const plan = defineExecutionPlan({ spec, requirements: { host: { os: ["macos"] },
    surfaces: { page: { kind: "browser", capabilities: ["browser.dom.inspect"] } } },
    effects: [{ resource: "browser.session", operation: "execute", boundary: "local",
      securitySensitive: false, recovery: "unknown" }] });
  const controller = new AbortController();
  if (behavior.aborted) controller.abort();
  const options: RunCaseV3Options = { platform: "web", runnerHostId: "runner-host",
    run: { id: "report-run-1", title: "Judge integration", app: {
      id: "fixture", name: "Fixture" }, hosts: [{ id: "runner-host", os: "macos" },
      { id: "browser-host", os: "linux" }] }, surfaces: [{ kind: "browser", backend: browser,
      requirement: { kind: "browser", surfaceId: "page", expectedHostId: "browser-host",
        capabilities: ["browser.dom.inspect"], engine: "chromium" } }],
    ...(provider === undefined ? {} : { judge: { provider,
      ...(behavior.omitJudgeDeadline ? {} : {
        deadlineAt: behavior.deadlineAt ?? Date.now() + 5_000,
      }),
      ...(behavior.aborted ? { signal: controller.signal } : {}) } }),
    execution: { plan, environment: { platform: "web", host: { os: "macos" },
      surfaces: { page: { kind: "browser", capabilities: ["browser.dom.inspect"] } } },
      policy: { maximumSideEffect: "writesLocal", grants: [{ resource: "browser.session",
        operations: ["execute"], boundaries: ["local"], allowUnknownRecovery: true }] },
      timeoutMs: behavior.executionTimeoutMs ?? 2_000, cleanupTimeoutMs: 500 },
    stagingDirectory: path.join(root, "staging"), outputDirectory: path.join(root, "report") };
  return { definition, options };
}

function criterion(evidenceArtifactId = "page-state") {
  return { id: "route", criterionId: "route-correct", rubricVersion: "route-v1",
    question: "登录页是否显示登录入口？", allowedLabels: ["sign-in", "sign-up"],
    passLabels: ["sign-in"], evidenceArtifactIds: [evidenceArtifactId] };
}

function baseDefinitionInput() {
  return { spec: caseSpec(), judgeCriteria: [criterion()], run: async () => {} };
}

function caseSpec() {
  return { id: "judge.integration", locale: "zh-CN", platforms: ["web"] as const,
    suite: { id: "judge", name: "语义判断" }, name: "登录路由判断",
    intent: "验证显式 Judge criterion 只消费当前尝试的证据。", preconditions: [],
    acceptanceCriteria: [{ id: "deterministic", text: "确定性步骤执行成功。" },
      { id: "route-correct", text: "页面显示正确登录入口。" }], sideEffect: "writesLocal" as const };
}

async function temporary(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-v3-judge-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
