import { rm } from "node:fs/promises";
import path from "node:path";

import { writeReportV3Bundle } from "@surfaceloom/reporter";

import { showcaseCases, showcaseRun } from "./matrix.mjs";

export async function aggregateChildReports(children, outputDirectory, { reportRunId } = {}) {
  assertRunId(reportRunId);
  if (!Array.isArray(children) || children.length !== showcaseCases.length) {
    throw new Error("The M1 aggregate requires exactly four child results.");
  }
  const ids = new Set();
  const verified = children.map((child) => prepareChild(child, reportRunId, ids));
  const expectedIds = new Set(showcaseCases.map((item) => item.id));
  if (ids.size !== expectedIds.size || [...ids].some((id) => !expectedIds.has(id))) {
    throw new Error("Child result identities do not match the fixed M1 matrix.");
  }
  const baseline = verified[0].run;
  for (const item of verified.slice(1)) assertSharedIdentity(baseline, item.run);
  const startedAt = verified.map((item) => item.run.startedAt).sort()[0];
  const finishedAt = verified.map((item) => item.run.finishedAt).sort().at(-1);
  const bundle = await writeReportV3Bundle({
    run: { ...baseline, id: reportRunId, title: showcaseRun.title, startedAt, finishedAt },
    tests: verified.map((item) => item.test),
  }, path.resolve(outputDirectory), {
    requiredArtifacts: verified.flatMap((item) => item.requiredArtifacts),
  });
  if (bundle.report.status !== "failed" || bundle.report.summary.discovered !== 4
      || bundle.report.summary.passed !== 2 || bundle.report.summary.failed !== 2
      || bundle.report.summary.skipped !== 0 || bundle.report.summary.unsupported !== 0) {
    await rm(bundle.directory, { recursive: true, force: true });
    throw new Error("The aggregate M1 verdict is not the honest 2-pass/2-fail matrix.");
  }
  return bundle;
}

function prepareChild(child, reportRunId, ids) {
  if (typeof child?.caseId !== "string" || typeof child.directory !== "string"
      || child.reportRunId !== reportRunId || ids.has(child.caseId)) {
    throw new Error("Child results must share one invocation and unique Case identities.");
  }
  const canonical = showcaseCases.find((item) => item.id === child.caseId);
  if (canonical === undefined) throw new Error("Child Case is outside the fixed M1 matrix.");
  const directory = path.resolve(child.directory);
  const report = child.bundle?.report;
  if (!report || path.resolve(child.bundle.directory) !== directory
      || report.schemaVersion !== "surfaceloom.report/v3" || report.run?.id !== reportRunId
      || report.run.title !== showcaseRun.title || !same(report.run.app, showcaseRun.app)
      || report.tests?.length !== 1 || report.tests[0]?.spec?.id !== canonical.id) {
    throw new Error(`Child ${canonical.id} is not the owned runner result for this invocation.`);
  }
  const test = report.tests[0];
  if (test.attempts?.state !== "known" || test.attempts.items?.length !== 1
      || test.attempts.finalAttemptId !== "attempt-1") {
    throw new Error(`Child ${canonical.id} has an unknown or ambiguous attempt.`);
  }
  const attempt = test.attempts.items[0];
  if (attempt.id !== "attempt-1" || attempt.ordinal !== 1
      || attempt.result?.status !== canonical.expectedStatus) {
    throw new Error(`Child ${canonical.id} produced an unexpected business verdict.`);
  }
  const artifacts = attempt.result.artifacts.map((artifact) => sourceArtifact(
    artifact, ownedArtifactPath(directory, artifact),
  ));
  const requiredArtifacts = attempt.result.artifacts.map((artifact) => ({
    caseId: canonical.id, attemptId: attempt.id, artifactId: artifact.id,
    expectedSizeBytes: artifact.sizeBytes, expectedSha256: artifact.sha256,
  }));
  ids.add(child.caseId);
  return Object.freeze({ run: report.run,
    test: { spec: test.spec, attempts: { ...test.attempts,
      items: [{ ...attempt, result: { ...attempt.result, artifacts } }] } },
    requiredArtifacts });
}

function ownedArtifactPath(directory, artifact) {
  if (artifact?.captureStatus !== "captured" || typeof artifact.relativePath !== "string"
      || path.isAbsolute(artifact.relativePath) || artifact.relativePath.includes("\\")) {
    throw new Error("Child contains an unavailable or invalid attachment.");
  }
  const source = path.resolve(directory, artifact.relativePath);
  if (!source.startsWith(`${directory}${path.sep}`)) {
    throw new Error("Child attachment escaped its owned report directory.");
  }
  return source;
}

function sourceArtifact(artifact, sourcePath) {
  const { contentTrust: _trust, relativePath: _path,
    sizeBytes: _size, sha256: _hash, ...source } = artifact;
  return { ...source, sourcePath };
}

function assertSharedIdentity(left, right) {
  for (const key of ["id", "title", "app", "environment", "hosts", "surfaces", "provenance"]) {
    if (!same(left[key], right[key])) throw new Error(`Child run identity differs at ${key}.`);
  }
}

function assertRunId(value) {
  if (typeof value !== "string" || !/^reference-agent\.m1\.[A-Za-z0-9-]{16,}$/u.test(value)) {
    throw new Error("The M1 aggregate requires one unique invocation reportRunId.");
  }
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
