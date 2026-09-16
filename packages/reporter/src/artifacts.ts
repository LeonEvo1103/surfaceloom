import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { copyArtifactFile, extensionForContentType } from "./artifact-file.js";
import { retainEvidence } from "./evidence-policy.js";
import type {
  EvidencePolicy,
  ReportArtifact,
  SourceArtifact,
  TestStatus,
} from "./model.js";
import { redactReportText } from "./redact.js";

export async function materializeArtifacts(
  outputDirectory: string,
  testId: string,
  status: TestStatus,
  artifacts: readonly SourceArtifact[],
  policy: EvidencePolicy,
): Promise<readonly ReportArtifact[]> {
  const retained = artifactsForRetention(artifacts, status, policy);
  if (retained.length === 0) return [];

  const testDirectoryName = `${safeSegment(testId)}-${shortHash(testId)}`;
  const retainedIds = new Set(retained.map((artifact) => artifact.id));
  const result: ReportArtifact[] = [];
  for (const [index, artifact] of retained.entries()) {
    if (artifact.captureStatus !== "captured") {
      result.push(Object.freeze(withoutSourcePath(artifact, retainedIds)));
      continue;
    }
    let temporary: string | undefined;
    try {
      const source = path.resolve(artifact.sourcePath!);
      const relativeDirectory = path.posix.join("evidence", testDirectoryName);
      const destinationDirectory = path.join(outputDirectory, "evidence", testDirectoryName);
      await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
      const filename = [
        String(index + 1).padStart(2, "0"),
        safeSegment(artifact.phase),
        safeSegment(artifact.kind),
      ].join("-") + extensionForContentType(artifact.contentType);
      const relativePath = path.posix.join(relativeDirectory, filename);
      const destination = path.join(destinationDirectory, filename);
      temporary = `${destination}.partial-${randomUUID()}`;
      const fileInfo = await copyArtifactFile(source, temporary, artifact.contentType);
      await rename(temporary, destination);
      temporary = undefined;
      result.push(Object.freeze({
        ...withoutSourcePath(artifact, retainedIds),
        relativePath,
        sizeBytes: fileInfo.sizeBytes,
        sha256: fileInfo.sha256,
      }));
    } catch (error) {
      if (temporary !== undefined) {
        try {
          await rm(temporary, { force: true });
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Evidence validation failed and its temporary file could not be removed.",
          );
        }
      }
      result.push(Object.freeze({
        ...withoutSourcePath(artifact, retainedIds),
        captureStatus: "captureFailed",
        captureError: captureFailureReason(error),
      }));
    }
  }
  return Object.freeze(result);
}

function artifactsForRetention(
  artifacts: readonly SourceArtifact[],
  status: TestStatus,
  policy: EvidencePolicy,
): readonly SourceArtifact[] {
  return artifacts.filter((artifact) => retainEvidence(artifact, status, policy));
}

function withoutSourcePath(
  artifact: SourceArtifact,
  retainedIds: ReadonlySet<string>,
): ReportArtifact {
  const relatedArtifactIds = artifact.relatedArtifactIds?.filter((id) => retainedIds.has(id));
  return {
    id: artifact.id,
    kind: artifact.kind,
    phase: artifact.phase,
    title: redactReportText(artifact.title),
    captureStatus: artifact.captureStatus,
    contentType: artifact.contentType,
    capturedAt: artifact.capturedAt,
    contentTrust: "untrusted",
    ...(artifact.reviewPriority === undefined
      ? {}
      : { reviewPriority: artifact.reviewPriority }),
    ...(artifact.stepId === undefined ? {} : { stepId: artifact.stepId }),
    ...(artifact.description === undefined
      ? {}
      : { description: redactReportText(artifact.description) }),
    ...(artifact.sensitive === undefined ? {} : { sensitive: artifact.sensitive }),
    ...(artifact.durationMs === undefined ? {} : { durationMs: artifact.durationMs }),
    ...(artifact.captureError === undefined
      ? {}
      : { captureError: redactReportText(artifact.captureError) }),
    ...(relatedArtifactIds === undefined
      ? {}
      : { relatedArtifactIds: Object.freeze(relatedArtifactIds) }),
  };
}

function captureFailureReason(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
  return code === undefined
    ? "Evidence file could not be materialized."
    : `Evidence file could not be materialized (${redactReportText(code)}).`;
}

function safeSegment(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized === "" || normalized === "." || normalized === ".."
    ? "artifact"
    : normalized;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
