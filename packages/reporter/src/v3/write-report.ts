import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";

import { materializeArtifacts } from "../artifacts.js";
import { defaultEvidencePolicy } from "../evidence-policy.js";
import type {
  CaseExecutionResultInput,
  EvidencePolicy,
  ReportedCaseExecutionResult,
} from "../model.js";
import { renderHTMLReportV3 } from "./render-html.js";
import { renderAIReviewV3 } from "./render-markdown.js";
import type {
  CaseReportV3Input,
  ReportBundleV3Input,
  ReportBundleV3Result,
  ReportedTestCaseV3,
  TestRunReportV3,
} from "./model.js";
import { reportSchemaVersionV3 } from "./model.js";
import { sanitizeReportV3Input } from "./sanitize.js";
import { overallStatusV3, summarizeTestsV3 } from "./summary.js";
import { validateEvidencePolicyV3 } from "./validate.js";

export interface WriteReportV3Options {
  readonly evidencePolicy?: Partial<EvidencePolicy>;
  /** Runner-owned publication gate, exact to a case attempt and artifact id. */
  readonly requiredArtifacts?: readonly RequiredReportArtifactV3[];
}

export interface RequiredReportArtifactV3 {
  readonly caseId: string;
  readonly attemptId: string;
  readonly artifactId: string;
  readonly expectedSizeBytes: number;
  readonly expectedSha256: string;
}

export type RequiredArtifactPublicationFailureCode =
  | "missing"
  | "captureFailed"
  | "retainedOut"
  | "invalidMaterialization"
  | "copyChanged";

export interface RequiredArtifactPublicationFailure extends RequiredReportArtifactV3 {
  readonly code: RequiredArtifactPublicationFailureCode;
}

export class RequiredArtifactPublicationError extends Error {
  readonly failures: readonly RequiredArtifactPublicationFailure[];

  constructor(failures: readonly RequiredArtifactPublicationFailure[]) {
    super("Required report artifacts could not be published.");
    this.name = "RequiredArtifactPublicationError";
    this.failures = Object.freeze([...failures]);
  }
}

export async function writeReportV3Bundle(
  input: ReportBundleV3Input,
  outputDirectory: string,
  options: WriteReportV3Options = {},
): Promise<ReportBundleV3Result> {
  const snapshot = sanitizeReportV3Input(input);
  const optionSnapshot = snapshotWriteOptions(options);
  const requiredArtifacts = optionSnapshot.requiredArtifacts;
  const evidencePolicy = Object.freeze({ ...defaultEvidencePolicy, ...optionSnapshot.evidencePolicy });
  validateEvidencePolicyV3(evidencePolicy);
  const output = path.resolve(outputDirectory);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  let createdOutput = false;
  try {
    await mkdir(output, { mode: 0o700 });
    createdOutput = true;
    const tests: ReportedTestCaseV3[] = [];
    for (const test of snapshot.tests) {
      tests.push(await materializeTest(output, test, evidencePolicy));
    }
    const frozenTests = Object.freeze(tests);
    await assertRequiredArtifactsPublished(output, snapshot.tests, frozenTests, requiredArtifacts);
    const summary = summarizeTestsV3(frozenTests);
    const report: TestRunReportV3 = Object.freeze({
      schemaVersion: reportSchemaVersionV3,
      run: snapshot.run,
      status: overallStatusV3(summary),
      summary,
      evidencePolicy,
      tests: frozenTests,
    });
    return await writeViews(output, report);
  } catch (error) {
    if (createdOutput) await rm(output, { recursive: true, force: true });
    if (isAlreadyExists(error)) throw new Error("Report output already exists.", { cause: error });
    throw error;
  }
}

async function assertRequiredArtifactsPublished(
  output: string,
  sourceTests: readonly CaseReportV3Input[],
  reportedTests: readonly ReportedTestCaseV3[],
  required: readonly RequiredReportArtifactV3[],
): Promise<void> {
  const failures: RequiredArtifactPublicationFailure[] = [];
  for (const item of required) {
    const sourceTest = sourceTests.find((test) => test.spec.id === item.caseId);
    const reportedTest = reportedTests.find((test) => test.spec.id === item.caseId);
    const sourceAttempt = sourceTest?.attempts.state === "known"
      ? sourceTest.attempts.items.find((attempt) => attempt.id === item.attemptId) : undefined;
    const reportedAttempt = reportedTest?.attempts.state === "known"
      ? reportedTest.attempts.items.find((attempt) => attempt.id === item.attemptId) : undefined;
    const sourceArtifact = sourceAttempt?.result.artifacts?.find(
      (artifact) => artifact.id === item.artifactId,
    );
    const artifact = reportedAttempt?.result.artifacts.find(
      (candidate) => candidate.id === item.artifactId,
    );
    if (sourceArtifact === undefined) {
      failures.push({ ...item, code: "missing" });
      continue;
    }
    if (artifact === undefined) {
      failures.push({ ...item, code: "retainedOut" });
      continue;
    }
    if (artifact.captureStatus !== "captured") {
      failures.push({ ...item, code: "captureFailed" });
      continue;
    }
    if (artifact.relativePath === undefined || artifact.sizeBytes === undefined
        || artifact.sha256 === undefined) {
      failures.push({ ...item, code: "invalidMaterialization" });
      continue;
    }
    try {
      const materializedPath = path.join(output, artifact.relativePath);
      const [info, bytes] = await Promise.all([stat(materializedPath), readFile(materializedPath)]);
      const actualSha256 = createHash("sha256").update(bytes).digest("hex");
      if (!info.isFile() || info.size !== artifact.sizeBytes
          || artifact.sizeBytes !== item.expectedSizeBytes
          || artifact.sha256 !== item.expectedSha256 || actualSha256 !== artifact.sha256
          || actualSha256 !== item.expectedSha256) {
        failures.push({ ...item, code: "copyChanged" });
      }
    } catch {
      failures.push({ ...item, code: "copyChanged" });
    }
  }
  if (failures.length > 0) throw new RequiredArtifactPublicationError(failures);
}

function snapshotRequiredArtifacts(
  input: unknown,
): readonly RequiredReportArtifactV3[] {
  if (typeof input !== "object" || input === null || types.isProxy(input) || !Array.isArray(input)
      || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new Error("requiredArtifacts must be a bounded plain array.");
  }
  const arrayDescriptors = Object.getOwnPropertyDescriptors(input);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
      || typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value > 10_000) {
    throw new Error("requiredArtifacts must be a bounded plain array.");
  }
  const length = lengthDescriptor.value as number;
  const allowedArrayKeys = new Set(["length", ...Array.from({ length }, (_value, index) => String(index))]);
  if (Reflect.ownKeys(arrayDescriptors).some((key) => typeof key !== "string"
      || !allowedArrayKeys.has(key))) {
    throw new Error("requiredArtifacts contains custom fields.");
  }
  const seen = new Set<string>();
  const result: RequiredReportArtifactV3[] = [];
  for (let index = 0; index < length; index += 1) {
    const itemDescriptor = arrayDescriptors[String(index)];
    if (itemDescriptor === undefined || !("value" in itemDescriptor) || !itemDescriptor.enumerable) {
      throw new Error(`requiredArtifacts[${index}] is a hole or accessor.`);
    }
    const item: unknown = itemDescriptor.value;
    if (typeof item !== "object" || item === null || types.isProxy(item)
        || Object.getPrototypeOf(item) !== Object.prototype) {
      throw new Error(`requiredArtifacts[${index}] must be a plain data object.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const allowed = ["caseId", "attemptId", "artifactId", "expectedSizeBytes", "expectedSha256"];
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
        || !allowed.includes(key))) {
      throw new Error(`requiredArtifacts[${index}] contains unknown metadata.`);
    }
    const field = (name: "caseId" | "attemptId" | "artifactId"): string => {
      const descriptor = descriptors[name];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable
          || typeof descriptor.value !== "string" || descriptor.value.length === 0
          || descriptor.value.length > 240 || /[\u0000-\u001f\u007f]/u.test(descriptor.value)) {
        throw new Error(`requiredArtifacts[${index}].${name} is invalid.`);
      }
      return descriptor.value;
    };
    const sizeDescriptor = descriptors.expectedSizeBytes;
    const hashDescriptor = descriptors.expectedSha256;
    if (sizeDescriptor === undefined || !("value" in sizeDescriptor) || !sizeDescriptor.enumerable
        || !Number.isSafeInteger(sizeDescriptor.value) || (sizeDescriptor.value as number) < 0
        || hashDescriptor === undefined || !("value" in hashDescriptor) || !hashDescriptor.enumerable
        || typeof hashDescriptor.value !== "string" || !/^[a-f0-9]{64}$/u.test(hashDescriptor.value)) {
      throw new Error(`requiredArtifacts[${index}] integrity is invalid.`);
    }
    const value = Object.freeze({ caseId: field("caseId"), attemptId: field("attemptId"),
      artifactId: field("artifactId"), expectedSizeBytes: sizeDescriptor.value as number,
      expectedSha256: hashDescriptor.value });
    const key = JSON.stringify([value.caseId, value.attemptId, value.artifactId]);
    if (seen.has(key)) throw new Error("Duplicate required report artifact.");
    seen.add(key);
    result.push(value);
  }
  return Object.freeze(result);
}

function snapshotWriteOptions(input: unknown): {
  readonly evidencePolicy: Partial<EvidencePolicy>;
  readonly requiredArtifacts: readonly RequiredReportArtifactV3[];
} {
  const descriptors = plainDescriptors(input, "Reporter v3 options", [
    "evidencePolicy", "requiredArtifacts",
  ]);
  const evidenceValue = dataField(descriptors.evidencePolicy, "Reporter v3 options.evidencePolicy", true);
  const requiredValue = dataField(descriptors.requiredArtifacts,
    "Reporter v3 options.requiredArtifacts", true);
  return Object.freeze({
    evidencePolicy: snapshotEvidencePolicy(evidenceValue),
    requiredArtifacts: snapshotRequiredArtifacts(requiredValue === undefined ? [] : requiredValue),
  });
}

function snapshotEvidencePolicy(input: unknown): Partial<EvidencePolicy> {
  if (input === undefined) return Object.freeze({});
  const allowed = ["screenshots", "video", "trace", "accessibilityTree", "logs"];
  const descriptors = plainDescriptors(input, "Reporter v3 evidencePolicy", allowed);
  const result: Record<string, "off" | "on-failure" | "always"> = {};
  for (const name of allowed as (keyof EvidencePolicy)[]) {
    const value = dataField(descriptors[name], `Reporter v3 evidencePolicy.${name}`, true);
    if (value === undefined) continue;
    if (value !== "off" && value !== "on-failure" && value !== "always") {
      throw new Error(`Reporter v3 evidencePolicy.${name} is invalid.`);
    }
    result[name] = value;
  }
  return Object.freeze(result) as Partial<EvidencePolicy>;
}

function plainDescriptors(input: unknown, label: string, allowed: readonly string[]):
  Record<PropertyKey, PropertyDescriptor> {
  if (typeof input !== "object" || input === null || types.isProxy(input)
      || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new Error(`${label} must be a plain data object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new Error(`${label} contains unknown metadata.`);
  }
  return descriptors;
}

function dataField(descriptor: PropertyDescriptor | undefined, label: string,
  optional = false): unknown {
  if (descriptor === undefined) {
    if (optional) return undefined;
    throw new Error(`${label} is required.`);
  }
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new Error(`${label} must be an enumerable data field.`);
  }
  return descriptor.value;
}

export function serializeReportV3(report: TestRunReportV3): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function materializeTest(
  output: string,
  test: CaseReportV3Input,
  policy: EvidencePolicy,
): Promise<ReportedTestCaseV3> {
  if (test.attempts.state === "unknown") {
    const result = await materializeResult(
      output, evidenceKey(test.spec.id, null), test.attempts.result, policy,
    );
    return Object.freeze({
      spec: test.spec,
      attempts: Object.freeze({
        state: "unknown",
        reason: test.attempts.reason,
        ...(test.attempts.detail === undefined ? {} : { detail: test.attempts.detail }),
        result,
      }),
    });
  }
  const items = [];
  for (const attempt of test.attempts.items) {
    const result = await materializeResult(
      output, evidenceKey(test.spec.id, attempt.id), attempt.result, policy,
    );
    items.push(Object.freeze({ ...attempt, result }));
  }
  return Object.freeze({
    spec: test.spec,
    attempts: Object.freeze({
      state: "known",
      finalAttemptId: test.attempts.finalAttemptId,
      items: Object.freeze(items),
    }),
  });
}

async function materializeResult(
  output: string,
  evidenceKey: string,
  result: CaseExecutionResultInput,
  policy: EvidencePolicy,
): Promise<ReportedCaseExecutionResult> {
  const artifacts = await materializeArtifacts(
    output, evidenceKey, result.status, result.artifacts ?? [], policy,
  );
  return Object.freeze({ ...result, artifacts });
}

async function writeViews(
  output: string,
  report: TestRunReportV3,
): Promise<ReportBundleV3Result> {
  const reportPath = path.join(output, "report.json");
  const htmlPath = path.join(output, "index.html");
  const aiReviewPath = path.join(output, "ai-review.md");
  const completionMarkerPath = path.join(output, "complete.json");
  const reportJSON = serializeReportV3(report);
  const pending = [
    { path: htmlPath, contents: renderHTMLReportV3(report) },
    { path: aiReviewPath, contents: renderAIReviewV3(report) },
    { path: reportPath, contents: reportJSON },
  ];
  await Promise.all(pending.map((file) => writeFile(`${file.path}.partial`, file.contents, {
    encoding: "utf8", flag: "wx", mode: 0o600,
  })));
  for (const file of pending) await rename(`${file.path}.partial`, file.path);
  const completion = {
    schemaVersion: "surfaceloom.report-bundle/v2",
    report: "report.json",
    reportSha256: digest(reportJSON),
    files: Object.fromEntries(pending.map((file) => [path.basename(file.path), digest(file.contents)])),
  };
  await writeFile(`${completionMarkerPath}.partial`, `${JSON.stringify(completion, null, 2)}\n`, {
    encoding: "utf8", flag: "wx", mode: 0o600,
  });
  await rename(`${completionMarkerPath}.partial`, completionMarkerPath);
  return Object.freeze({ directory: output, completionMarkerPath, reportPath, htmlPath,
    aiReviewPath, report });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceKey(caseId: string, attemptId: string | null): string {
  return JSON.stringify([caseId, attemptId]);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
