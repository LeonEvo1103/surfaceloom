import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { TraceValue } from "@surfaceloom/core";
import { judge, type EvidenceDescriptor, type JudgeOutcome, type JudgeRequest } from "@surfaceloom/llm-judge";
import { createJudgeEvidenceV3, type CaseExecutionResultInput } from "@surfaceloom/reporter";

import type { EvidenceCollectionSnapshot } from "../evidence/collector.js";
import type { ExecutionScope } from "../evidence/execution-scope.js";
import { identifier } from "../evidence/execution-scope.js";
import type { MaterializedEvidenceV3 } from "../report/v3/contracts.js";
import { assertMaterializedEvidenceV3, materializedEvidenceIntegrity } from "../report/v3/materialize.js";
import type { RequiredReportArtifactReferenceV3 } from "../report/v3/required-artifacts.js";
import { mergeFailureOrigins, type RunCaseV3FailureOrigin } from "../failure-origin.js";
import type { JudgeCriterionV3, JudgeIntegrationV3Result, JudgeRunnerBindingV3 } from "./contracts.js";
import {
  assertMaterializedImageEvidenceV3,
  materializedImageIntegrityV3,
  type ImageEvidenceSnapshotV3,
  type MaterializedImageEvidenceV3,
} from "./image-evidence.js";

interface RunJudgeCriteriaV3Input {
  readonly caseId: string;
  readonly reportRunId: string;
  readonly criteria: readonly JudgeCriterionV3[];
  readonly binding?: JudgeRunnerBindingV3;
  readonly scope: ExecutionScope;
  readonly execution: {
    readonly signal: AbortSignal;
    readonly deadlineAt: number;
    readonly externalSignal?: AbortSignal;
  };
  readonly evidence: EvidenceCollectionSnapshot;
  readonly materialized: MaterializedEvidenceV3;
  readonly imageEvidence: ImageEvidenceSnapshotV3;
  readonly materializedImages: MaterializedImageEvidenceV3;
  readonly stagingDirectory: string;
}

interface SelectedEvidence {
  readonly artifactId: string;
  readonly evidenceId: string;
  readonly completeness: "complete" | "incomplete";
  readonly descriptor: () => EvidenceDescriptor;
  readonly required: RequiredReportArtifactReferenceV3;
}

export async function runJudgeCriteriaV3(
  input: RunJudgeCriteriaV3Input,
): Promise<JudgeIntegrationV3Result> {
  assertMaterializedEvidenceV3(input.materialized, input.evidence);
  assertMaterializedImageEvidenceV3(input.materializedImages, input.imageEvidence);
  const caseId = identifier("Judge caseId", input.caseId);
  const reportRunId = identifier("Judge reportRunId", input.reportRunId);
  const textArtifacts = new Map(input.materialized.artifacts.map((item) => [item.id, item]));
  const imageArtifacts = new Map(input.materializedImages.artifacts.map((item) => [item.id, item]));
  const textCompleteness = new Map(input.evidence.artifacts.map((item) =>
    [item.artifact.artifactId, item.completeness.state] as const));
  textCompleteness.set(input.evidence.graphArtifactId, input.evidence.completeness.state);
  const imageCompleteness = new Map(input.imageEvidence.artifacts.map((item) =>
    [item.artifactId, item.completeness.state] as const));
  const textIntegrity = new Map(materializedEvidenceIntegrity(input.materialized, input.evidence)
    .map((item) => [item.artifactId, item]));
  const imageIntegrity = new Map(materializedImageIntegrityV3(input.materializedImages,
    input.imageEvidence).map((item) => [item.artifactId, item]));
  for (const artifactId of imageArtifacts.keys()) {
    if (textArtifacts.has(artifactId)) throw new Error(`Duplicate evidence artifact id: ${artifactId}.`);
  }
  const reserved = new Set([...textArtifacts.keys(), ...imageArtifacts.keys()]);
  const steps: JudgeIntegrationV3Result["steps"][number][] = [];
  const artifacts: JudgeIntegrationV3Result["artifacts"][number][] = [];
  const required = new Map<string, RequiredReportArtifactReferenceV3>();
  let failed = false;
  let failureOrigin: RunCaseV3FailureOrigin = null;
  let failureMessage: string | undefined;

  for (const criterion of input.criteria) {
    const started = performance.now();
    const artifactId = `judge.${criterion.id}.result`;
    if (reserved.has(artifactId)) throw new Error(`Judge result artifact id collides: ${artifactId}.`);
    reserved.add(artifactId);
    const selected = criterion.evidenceArtifactIds.map((selectedId, index) =>
      selectEvidence(input, caseId, reportRunId, criterion.id, selectedId, index,
        textArtifacts, imageArtifacts, textCompleteness, imageCompleteness,
        textIntegrity, imageIntegrity));
    for (const item of selected) required.set(item.artifactId, item.required);

    let outcome: JudgeOutcome;
    if (selected.some((item) => item.completeness !== "complete")) {
      outcome = insufficient(selected.map((item) => item.evidenceId),
        "Selected evidence is incomplete; provider was not invoked.");
    } else {
      assertMaterializedEvidenceV3(input.materialized, input.evidence);
      assertMaterializedImageEvidenceV3(input.materializedImages, input.imageEvidence);
      const request: JudgeRequest = Object.freeze({ serviceRunId: reportRunId,
        rubricVersion: criterion.rubricVersion, question: criterion.question,
        allowedLabels: criterion.allowedLabels,
        evidence: Object.freeze(selected.map((item) => Object.freeze(item.descriptor()))) });
      outcome = await invokeJudge(input.binding, request, input.execution);
    }
    const decision = decide(criterion, outcome);
    failed ||= decision.status === "failed";
    failureOrigin = mergeFailureOrigins(failureOrigin, judgeFailureOrigin(criterion, outcome));
    failureMessage ??= decision.status === "failed" ? decision.reason : undefined;
    const correlationId = `judge.${input.scope.caseExecutionId}.${input.scope.attemptId}.${criterion.id}`;
    const sourcePath = path.join(path.resolve(input.stagingDirectory), `${artifactId}.json`);
    const capturedAt = new Date().toISOString();
    const output = createJudgeEvidenceV3({ artifactId, capturedAt, sourcePath,
      binding: { reportRunId, caseExecutionId: input.scope.caseExecutionId,
        attemptId: input.scope.attemptId, judgeCriterionId: criterion.id,
        acceptanceCriterionId: criterion.criterionId }, correlationId,
      evidence: selected.map((item) => ({ evidenceId: item.evidenceId,
        artifactId: item.artifactId })), outcome: outcome as unknown as TraceValue,
      decision: { status: decision.status, reason: decision.reason } });
    const bytes = Buffer.from(`${JSON.stringify(output.record, null, 2)}\n`, "utf8");
    await writeFile(sourcePath, bytes, { flag: "wx", mode: 0o600 });
    artifacts.push(output.artifact);
    required.set(artifactId, Object.freeze({ caseId, attemptId: input.scope.attemptId,
      artifactId, expectedSizeBytes: bytes.byteLength,
      expectedSha256: createHash("sha256").update(bytes).digest("hex") }));
    steps.push(Object.freeze({ id: `judge.${criterion.id}`, title: `Judge：${criterion.question}`,
      status: decision.status, durationMs: Math.max(0, performance.now() - started),
      assertion: decision.reason, criterionIds: Object.freeze([criterion.criterionId]) }));
  }
  return Object.freeze({ steps: Object.freeze(steps), artifacts: Object.freeze(artifacts),
    requiredArtifacts: Object.freeze([...required.values()]), failed, failureOrigin,
    ...(failureMessage === undefined ? {} : { failureMessage }) });
}

export function mergeJudgeResultV3(result: CaseExecutionResultInput,
  judgeResult: JudgeIntegrationV3Result): CaseExecutionResultInput {
  const deterministicFailure = result.status !== "passed";
  const judgeFailure = !deterministicFailure && judgeResult.failed;
  const status = judgeFailure ? "failed" as const : result.status;
  return Object.freeze({ ...result, status,
    durationMs: result.durationMs + judgeResult.steps.reduce((sum, step) => sum + step.durationMs, 0),
    steps: Object.freeze([...result.steps, ...judgeResult.steps]),
    artifacts: Object.freeze([...(result.artifacts ?? []), ...judgeResult.artifacts]),
    ...(judgeFailure ? { error: Object.freeze({ category: "judge",
      message: judgeResult.failureMessage ?? "Judge criterion failed conservatively." }) } : {}) });
}

async function invokeJudge(binding: JudgeRunnerBindingV3 | undefined, request: JudgeRequest,
  execution: RunJudgeCriteriaV3Input["execution"]): Promise<JudgeOutcome> {
  if (binding === undefined) return providerFailure("Judge provider is not configured.", "provider");
  const deadlineAt = Math.min(execution.deadlineAt, binding.deadlineAt ?? Number.MAX_SAFE_INTEGER);
  const signals = [execution.signal, execution.externalSignal, binding.signal]
    .filter((value): value is AbortSignal => value !== undefined);
  const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
  if (signal.aborted) return providerFailure("Judge invocation was aborted.", "aborted");
  if (Date.now() >= deadlineAt) return providerFailure("Judge deadline was exceeded.", "deadlineExceeded");
  try {
    const outcome = await judge(binding.provider, request, { deadlineAt, signal });
    if (signal.aborted) return providerFailure("Judge invocation was aborted.", "aborted");
    if (Date.now() >= deadlineAt) return providerFailure("Judge deadline was exceeded.", "deadlineExceeded");
    return outcome;
  } catch {
    return providerFailure("Judge request or invocation failed validation.", "invalidResponse");
  }
}

function selectEvidence(input: RunJudgeCriteriaV3Input, caseId: string, reportRunId: string,
  criterionId: string, artifactId: string, index: number,
  textArtifacts: ReadonlyMap<string, JudgeIntegrationV3Result["artifacts"][number]>,
  imageArtifacts: ReadonlyMap<string, JudgeIntegrationV3Result["artifacts"][number]>,
  textCompleteness: ReadonlyMap<string, "complete" | "incomplete">,
  imageCompleteness: ReadonlyMap<string, "complete" | "incomplete">,
  textIntegrity: ReadonlyMap<string, { sourcePath: string; sizeBytes: number; sha256: string }>,
  imageIntegrity: ReadonlyMap<string, { sourcePath: string; sizeBytes: number; sha256: string;
    mediaType: "image/png" | "image/jpeg" | "image/webp" }>,
): SelectedEvidence {
  const evidenceId = `judge.${criterionId}.evidence.${index + 1}`;
  const text = textArtifacts.get(artifactId);
  const image = imageArtifacts.get(artifactId);
  if ((text === undefined) === (image === undefined)) {
    throw new Error(`Judge criterion ${criterionId} references evidence outside its current attempt.`);
  }
  if (text !== undefined) {
    const integrity = textIntegrity.get(artifactId);
    const completeness = textCompleteness.get(artifactId);
    if (text.captureStatus !== "captured" || text.sourcePath === undefined
        || integrity === undefined || completeness === undefined) {
      throw new Error(`Judge criterion ${criterionId} references evidence that was not materialized.`);
    }
    return Object.freeze({ artifactId, evidenceId, completeness,
      descriptor: (): EvidenceDescriptor => ({ kind: "text", evidenceId, serviceRunId: reportRunId,
        origin: { kind: "serviceArtifact", artifactId }, contentType: "text/plain",
        text: readFileSync(integrity.sourcePath, "utf8").trim() }),
      required: Object.freeze({ caseId, attemptId: input.scope.attemptId, artifactId,
        expectedSizeBytes: integrity.sizeBytes, expectedSha256: integrity.sha256 }) });
  }
  const integrity = imageIntegrity.get(artifactId)!;
  const completeness = imageCompleteness.get(artifactId);
  if (image!.captureStatus !== "captured" || image!.sourcePath === undefined
      || integrity === undefined || completeness === undefined) {
    throw new Error(`Judge criterion ${criterionId} references image evidence that was not materialized.`);
  }
  return Object.freeze({ artifactId, evidenceId, completeness,
    descriptor: (): EvidenceDescriptor => {
      const bytes = readFileSync(integrity.sourcePath);
      return { kind: "image", evidenceId, serviceRunId: reportRunId,
        origin: { kind: "serviceArtifact", artifactId }, mediaType: integrity.mediaType,
        byteLength: bytes.byteLength, dataBase64: bytes.toString("base64") };
    },
    required: Object.freeze({ caseId, attemptId: input.scope.attemptId, artifactId,
      expectedSizeBytes: integrity.sizeBytes, expectedSha256: integrity.sha256 }) });
}

function judgeFailureOrigin(criterion: JudgeCriterionV3,
  outcome: JudgeOutcome): RunCaseV3FailureOrigin {
  if (outcome.status === "providerFailure") return "infrastructure";
  if (outcome.status === "insufficient") return "insufficient";
  if (!criterion.allowedLabels.includes(outcome.label)) return "infrastructure";
  return criterion.passLabels.includes(outcome.label) ? null : "business";
}

function decide(criterion: JudgeCriterionV3, outcome: JudgeOutcome): {
  readonly status: "passed" | "failed";
  readonly reason: string;
} {
  if (outcome.status === "classified" && criterion.allowedLabels.includes(outcome.label)) {
    return criterion.passLabels.includes(outcome.label)
      ? { status: "passed", reason: `Judge classified ${outcome.label}.` }
      : { status: "failed", reason: `Judge classified non-passing label ${outcome.label}.` };
  }
  if (outcome.status === "insufficient") {
    return { status: "failed", reason: "Judge evidence was insufficient." };
  }
  if (outcome.status === "providerFailure") {
    return { status: "failed", reason: `Judge provider failure: ${outcome.failure.kind}.` };
  }
  return { status: "failed", reason: "Judge returned a non-allowed classification." };
}

function insufficient(evidenceRefs: readonly string[], reason: string): JudgeOutcome {
  return Object.freeze({ status: "insufficient", reason,
    reasons: Object.freeze([reason]), evidenceRefs: Object.freeze([...evidenceRefs]),
    observedFacts: Object.freeze([]), hypotheses: Object.freeze([]),
    providerMetadata: Object.freeze({ provider: "runner", model: "not-invoked" }) });
}

function providerFailure(message: string,
  kind: "provider" | "aborted" | "deadlineExceeded" | "invalidResponse"): JudgeOutcome {
  return Object.freeze({ status: "providerFailure",
    failure: Object.freeze({ kind, message, retryable: false }) });
}
