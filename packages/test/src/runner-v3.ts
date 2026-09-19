import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";

import {
  defaultEvidencePolicy,
  validateEvidencePolicyV3,
  writeReportV3Bundle,
  type CaseReportV3Input,
  type EvidencePolicy,
  type NormalizedCaseReportInput,
  type ReportBundleV3Input,
  type ReportRunV3,
} from "@surfaceloom/reporter";

import type { CaseContext, CaseDefinition } from "./contracts.js";
import { requireCaseV3 } from "./definition-v3.js";
import {
  EvidenceSubmissionCollector,
  RunnerExecutionAuthority,
  RunnerRequiredEvidenceAuthority,
  SurfaceAcquisitionRegistry,
  type ExecutionScope,
  type SurfaceCleanup,
} from "./evidence/index.js";
import { executeCaseWithRunnerContext } from "./execute.js";
import { createCaseReportV3, createReportV3Attempt, createSurfaceCatalogV3 } from "./report/v3/adapter.js";
import { materializeEvidenceV3 } from "./report/v3/materialize.js";
import {
  requiredReportArtifactsV3,
  type RequiredReportArtifactReferenceV3,
} from "./report/v3/required-artifacts.js";
import type {
  CaseContextV3,
  CaseDefinitionV3,
  CaseEvidenceSubmissionV3,
  CaseSurfaceV3,
  RunCaseV3Options,
  RunCaseV3Result,
  RunnerSurfaceV3,
} from "./runner-v3-contracts.js";
import { snapshotCaseEvidenceSubmissionV3 } from "./runner-v3-evidence.js";
import { RunCaseV3Error } from "./runner-v3-error.js";
import { RunnerV3GateBarrier } from "./runner-v3-gate.js";
import { snapshotRunCaseV3ExecutionGate, snapshotRunCaseV3Options } from "./runner-v3-options.js";
import { claimRunPaths, releaseRunPaths, type RunPathClaim } from "./runner-v3-paths.js";
import { createBrowserSurfaceFactory } from "./surfaces/browser.js";
import { createNativeSurfaceFactory } from "./surfaces/native.js";
import type { SurfaceEvidenceEvent, SurfaceSetupContext } from "./surfaces/contracts.js";

export interface PreparedCaseV3 {
  readonly input: ReportBundleV3Input;
  readonly requiredArtifacts: readonly RequiredReportArtifactReferenceV3[];
  readonly kernelReport: NormalizedCaseReportInput;
}

interface AcquiredSurface {
  readonly author: CaseSurfaceV3;
  readonly facts: {
    readonly surfaceId: string;
    readonly kind: "browser" | "desktop";
    readonly hostId: string;
    readonly executionPlatform: "web" | "macos" | "windows";
    readonly effectiveCapabilities: readonly string[];
    readonly ownership: "owned" | "borrowed";
  };
}

interface PreparedState { readonly claim: RunPathClaim; readonly gate: RunnerV3GateBarrier }
const preparedClaims = new WeakMap<PreparedCaseV3, PreparedState>();
const stickyClaims = new WeakSet<RunPathClaim>();

/** Explicit v3 runner path. Legacy executeCase/runCaseSuite remain v2-only. */
export async function runCaseV3(definition: CaseDefinitionV3,
  options: RunCaseV3Options): Promise<RunCaseV3Result> {
  const gate = new RunnerV3GateBarrier(snapshotRunCaseV3ExecutionGate(options));
  let snapshot: RunCaseV3Options;
  let prepared: PreparedCaseV3;
  try {
    requireCaseV3(definition);
    snapshot = snapshotRunCaseV3Options(options);
    const claim = await claimAndPreflight(snapshot);
    prepared = await prepareClaimedCaseV3(definition, snapshot, claim, gate);
  } catch (error) {
    await finalizeWithoutMasking(gate);
    throw error;
  }
  try {
    const bundle = await publishPreparedCaseV3(prepared, snapshot.outputDirectory,
      snapshot.evidencePolicy);
    return Object.freeze({ bundle, exitCode: bundle.report.status === "passed" ? 0 : 1 });
  } catch (error) {
    throw new RunCaseV3Error(prepared.kernelReport, "publication", error);
  }
}

/** Runner-internal split used to test the publication TOCTOU boundary. Not in the public barrel. */
export async function prepareCaseV3(definition: CaseDefinitionV3,
  options: RunCaseV3Options): Promise<PreparedCaseV3> {
  const gate = new RunnerV3GateBarrier(snapshotRunCaseV3ExecutionGate(options));
  try {
    requireCaseV3(definition);
    const snapshot = snapshotRunCaseV3Options(options);
    const claim = await claimAndPreflight(snapshot);
    return await prepareClaimedCaseV3(definition, snapshot, claim, gate);
  } catch (error) {
    await finalizeWithoutMasking(gate);
    throw error;
  }
}

async function prepareClaimedCaseV3(definition: CaseDefinitionV3,
  options: RunCaseV3Options, claim: RunPathClaim, gate: RunnerV3GateBarrier): Promise<PreparedCaseV3> {
  try { return await prepareSnapshotCaseV3(definition, options, claim, gate); }
  catch (error) {
    if (!stickyClaims.has(claim)) releaseRunPaths(claim);
    throw error;
  }
}

async function prepareSnapshotCaseV3(definition: CaseDefinitionV3,
  options: RunCaseV3Options, claim: RunPathClaim, gate: RunnerV3GateBarrier): Promise<PreparedCaseV3> {
  if (options.surfaces.length === 0) {
    throw new Error("The explicit v3 runner requires at least one real surface.");
  }
  const runStartedAt = new Date().toISOString();
  const authority = new RunnerExecutionAuthority({ reportRunId: options.run.id,
    runnerHostId: options.runnerHostId });
  const scope = authority.issue({ caseExecutionId: executionId(definition.spec.id),
    attemptId: "attempt-1", ordinal: 1 });
  const evidence = new EvidenceSubmissionCollector(scope);
  const registry = new SurfaceAcquisitionRegistry(scope);
  const requiredPolicy = new RunnerRequiredEvidenceAuthority().issue(scope,
    options.requiredEvidence ?? []);
  const evidencePolicy = policy(options.evidencePolicy);
  const acquired: AcquiredSurface[] = [];
  const shell = definition as CaseDefinition;
  const execution = await executeCaseWithRunnerContext(shell, {
    ...options.execution, platform: options.platform,
  }, async (base, internals) => {
    const setup = surfaceSetupContext(base, internals.cleanupBoundary.deadlineAt,
      evidenceSink(evidence, scope));
    for (const config of options.surfaces) {
      gate.markGuiAcquisitionStarted();
      const author = config.kind === "browser"
        ? await createBrowserSurfaceFactory(config.backend, {
          ...(options.execution.cleanupTimeoutMs === undefined ? {} : {
            cleanupTimeoutMs: options.execution.cleanupTimeoutMs,
          }),
          cleanupStop: internals.cleanupBoundary,
          ...(config.lease === undefined ? {} : { lease: config.lease }),
        }).setup(config.requirement, setup)
        : await createNativeSurfaceFactory(config.backend).setup(config.requirement, setup);
      gate.markGuiAcquisitionCompleted();
      acquired.push(captureAcquisition(config, author));
    }
    await definition.run(authorContext(base, acquired, evidence, scope));
  });
  gate.observeExecution(execution);
  if (!execution.publicationReady) {
    if (execution.worker.state !== "notStarted") stickyClaims.add(claim);
    throw new RunCaseV3Error(execution.report, "kernelStop",
      new Error("Execution producer or cleanup did not reach a publishable terminal state."));
  }
  if (acquired.length === 0) {
    throw new RunCaseV3Error(execution.report, "surfaceAcquisition",
      new Error("No v3 surface was actually acquired."));
  }
  let surfaces: ReturnType<SurfaceAcquisitionRegistry["seal"]>;
  let evidenceSnapshot: ReturnType<EvidenceSubmissionCollector["seal"]>;
  try {
    submitSurfaceAcquisitions(registry, scope, acquired, execution.cleanup.status === "passed");
    surfaces = registry.seal();
    evidenceSnapshot = evidence.seal({ capturedAt: new Date().toISOString() });
  } catch (error) {
    throw new RunCaseV3Error(execution.report, "evidence", error);
  }
  let materialized: Awaited<ReturnType<typeof materializeEvidenceV3>>;
  try { materialized = await materializeEvidenceV3(evidenceSnapshot, options.stagingDirectory); }
  catch (error) { throw new RunCaseV3Error(execution.report, "materialization", error); }
  let reportCase: CaseReportV3Input;
  try {
    const adapted = createReportV3Attempt({ scope, surfaces, evidence: evidenceSnapshot,
      materializedEvidence: materialized, requiredEvidencePolicy: requiredPolicy,
      evidencePolicy, result: execution.report.result });
    const finalAttempt = authority.finalize(scope.caseExecutionId, scope.attemptId);
    reportCase = createCaseReportV3({ spec: definition.spec, attempts: [adapted], finalAttempt });
  } catch (error) { throw new RunCaseV3Error(execution.report, "adaptation", error); }
  const runFinishedAt = finishTimestamp(execution.report.result.startedAt,
    execution.report.result.durationMs);
  const run: ReportRunV3 = Object.freeze({ id: options.run.id, title: options.run.title,
    startedAt: earlier(runStartedAt, execution.report.result.startedAt), finishedAt: runFinishedAt,
    app: options.run.app, ...(options.run.environment === undefined ? {} : {
      environment: options.run.environment,
    }), provenance: Object.freeze({ kind: "native" as const }),
    hosts: Object.freeze({ state: "known" as const, value: Object.freeze([...options.run.hosts]) }),
    surfaces: createSurfaceCatalogV3([surfaces]) });
  const input = Object.freeze({ run, tests: Object.freeze([reportCase]) });
  const requiredArtifacts = requiredReportArtifactsV3(definition.spec.id, requiredPolicy,
    materialized, evidenceSnapshot);
  const prepared = Object.freeze({ input, requiredArtifacts, kernelReport: execution.report });
  preparedClaims.set(prepared, Object.freeze({ claim, gate }));
  return prepared;
}

export async function publishPreparedCaseV3(prepared: PreparedCaseV3, outputDirectory: string,
  evidencePolicy?: Partial<EvidencePolicy>) {
  const state = preparedClaims.get(prepared);
  if (state === undefined) throw new Error("Prepared v3 Case has no active runner path claim.");
  const { claim, gate } = state;
  if (snapshotRunPath(outputDirectory) !== claim.outputDirectory) {
    preparedClaims.delete(prepared);
    releaseRunPaths(claim);
    await gate.finalize();
    throw new Error("Prepared v3 Case output does not match its runner path claim.");
  }
  try {
    return await writeReportV3Bundle(prepared.input, claim.outputDirectory, {
      requiredArtifacts: prepared.requiredArtifacts,
      ...(evidencePolicy === undefined ? {} : { evidencePolicy }),
    });
  } finally {
    preparedClaims.delete(prepared);
    releaseRunPaths(claim);
    await gate.finalize();
  }
}

async function finalizeWithoutMasking(gate: RunnerV3GateBarrier): Promise<void> {
  try { await gate.finalize(); } catch { /* Persistent quarantine remains fail-closed. */ }
}

function surfaceSetupContext(base: CaseContext, deadlineAt: number,
  sink: SurfaceSetupContext["evidence"]): SurfaceSetupContext {
  return Object.freeze({ signal: base.signal, deadlineAt, remainingMs: () => base.remainingMs(),
    dispatch: base.dispatch, registerResource: base.registerResource, evidence: sink });
}

function authorContext(base: CaseContext, acquired: readonly AcquiredSurface[],
  collector: EvidenceSubmissionCollector, scope: ExecutionScope): CaseContextV3 {
  const byId = new Map(acquired.map((item) => [item.author.surfaceId, item.author]));
  return Object.freeze({ ...base,
    surface: (surfaceId: string) => {
      const result = byId.get(surfaceId);
      if (result === undefined) throw new Error(`Surface ${surfaceId} was not acquired by the runner.`);
      return result;
    },
    evidence: Object.freeze({ submit: (input: CaseEvidenceSubmissionV3) =>
      submitAuthorEvidence(collector, scope, input) }),
  });
}

function evidenceSink(collector: EvidenceSubmissionCollector,
  scope: ExecutionScope): SurfaceSetupContext["evidence"] {
  let sequence = 0;
  return Object.freeze({ submit: (event: SurfaceEvidenceEvent) => {
    sequence += 1;
    const id = `surface.${event.surfaceId}.${sequence}`;
    submitEvidence(collector, scope, id, id, "adapter", "surface-provider", {
      kind: "probe", probeId: id, resource: `surface.${event.kind}`,
      outcome: event.outcome === "succeeded" ? "observed"
        : event.outcome === "unknown" ? "unknown" : "notObserved",
      value: { eventKind: event.kind, outcome: event.outcome,
        ...(event.operation === undefined ? {} : { operation: event.operation }) },
    }, { state: "complete" });
  } });
}

function submitAuthorEvidence(collector: EvidenceSubmissionCollector, scope: ExecutionScope,
  input: CaseEvidenceSubmissionV3): void {
  const snapshot = snapshotCaseEvidenceSubmissionV3(input);
  submitEvidence(collector, scope, snapshot.id, snapshot.artifactId, "probe", "case-author",
    snapshot.content, snapshot.completeness ?? { state: "complete" }, snapshot.correlationId);
}

function submitEvidence(collector: EvidenceSubmissionCollector, scope: ExecutionScope,
  id: string, artifactId: string, sourceKind: "adapter" | "probe", producerId: string,
  content: unknown, completeness: CaseEvidenceSubmissionV3["completeness"],
  correlationId?: string): void {
  const source = { kind: sourceKind, producerId, sourceRecordId: id } as const;
  const artifact = { kind: "artifact" as const, caseExecutionId: scope.caseExecutionId,
    attemptId: scope.attemptId, artifactId };
  collector.submit({ id, scope, source, artifact, nodes: [{ ...artifact, source }],
    relations: [{ id: `link.${id}`, relation: "contains", from: {
      kind: "attempt", caseExecutionId: scope.caseExecutionId, attemptId: scope.attemptId,
    }, to: artifact, source }], content, completeness: completeness ?? { state: "complete" },
    capturedAt: new Date().toISOString(),
    ...(correlationId === undefined ? {} : { correlationId }) });
}

function submitSurfaceAcquisitions(registry: SurfaceAcquisitionRegistry, scope: ExecutionScope,
  acquired: readonly AcquiredSurface[], cleanupPassed: boolean): void {
  for (const [index, item] of acquired.entries()) {
    const provider = registry.authorizeProvider(`runner.surface.${index + 1}`);
    const cleanup: SurfaceCleanup = item.facts.ownership === "borrowed"
      ? { status: "notRequired", resource: item.facts.surfaceId }
      : cleanupPassed ? { status: "confirmed", resource: item.facts.surfaceId }
        : { status: "unconfirmed", resource: item.facts.surfaceId,
          reason: "Runner resource cleanup was not fully confirmed." };
    provider.submit({ scope, ...item.facts, cleanup });
  }
}

function captureAcquisition(config: RunnerSurfaceV3, author: CaseSurfaceV3): AcquiredSurface {
  const facts = Object.freeze({ surfaceId: author.surfaceId,
    kind: author.kind === "browser" ? "browser" as const : "desktop" as const,
    hostId: config.backend.hostId,
    executionPlatform: author.kind === "browser" ? "web" as const : author.platform,
    effectiveCapabilities: Object.freeze([...author.capabilities]),
    ownership: author.kind === "browser" ? "owned" as const : author.ownership });
  return Object.freeze({ author, facts });
}

async function preflightRunPaths(options: RunCaseV3Options): Promise<void> {
  for (const [label, candidate] of [["staging", options.stagingDirectory],
    ["output", options.outputDirectory]] as const) {
    try {
      await lstat(candidate);
      throw new Error(`Runner v3 ${label} directory already exists; runs are non-idempotent.`);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
  }
}

async function claimAndPreflight(options: RunCaseV3Options): Promise<RunPathClaim> {
  const claim = claimRunPaths(options.stagingDirectory, options.outputDirectory);
  try { await preflightRunPaths(options); return claim; }
  catch (error) { releaseRunPaths(claim); throw error; }
}

function snapshotRunPath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) throw new Error("Runner v3 output path is invalid.");
  return path.resolve(input);
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  return descriptor !== undefined && "value" in descriptor && descriptor.value === "ENOENT";
}

function policy(input: Partial<EvidencePolicy> | undefined): EvidencePolicy {
  const result = Object.freeze({ ...defaultEvidencePolicy, ...input });
  validateEvidencePolicyV3(result);
  return result;
}

function executionId(caseId: string): string {
  return `case-${createHash("sha256").update(caseId).digest("hex").slice(0, 24)}`;
}

function finishTimestamp(startedAt: string, durationMs: number): string {
  return new Date(Date.parse(startedAt) + Math.ceil(durationMs)).toISOString();
}

function earlier(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}
