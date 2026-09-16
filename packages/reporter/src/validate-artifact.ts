import type {
  ArtifactKind,
  CaseExecutionResultInput,
  SourceArtifact,
} from "./model.js";
import {
  validateDuration,
  validateIdentifier,
  validateNonEmpty,
  validateTimestamp,
} from "./validation-primitives.js";

const captureStatuses = new Set(["captured", "captureFailed", "unsupported", "notRequested"]);
const artifactPhases = new Set(["before", "step", "after", "failure"]);

const contentTypes: Readonly<Record<ArtifactKind, readonly string[]>> = {
  screenshot: ["image/png", "image/jpeg", "image/webp"],
  videoFrame: ["image/png", "image/jpeg", "image/webp"],
  video: ["video/mp4", "video/webm", "video/quicktime"],
  trace: ["application/json", "application/x-ndjson", "application/zip"],
  agentLoop: ["text/html", "application/json"],
  accessibilityTree: ["application/json", "text/plain"],
  log: ["text/plain", "application/x-ndjson"],
  diagnostics: ["application/json", "application/zip", "text/plain"],
};

export function validateArtifact(
  testId: string,
  steps: CaseExecutionResultInput["steps"],
  artifact: SourceArtifact,
): void {
  validateIdentifier("artifact id", artifact.id);
  validateNonEmpty("artifact title", artifact.title);
  if (!captureStatuses.has(artifact.captureStatus)) {
    throw new Error("Unknown artifact capture status.");
  }
  if (!artifactPhases.has(artifact.phase)) {
    throw new Error("Unknown artifact phase.");
  }
  if (!Object.prototype.hasOwnProperty.call(contentTypes, artifact.kind)) {
    throw new Error("Unknown artifact kind.");
  }
  if (artifact.reviewPriority !== undefined
      && artifact.reviewPriority !== "primary"
      && artifact.reviewPriority !== "secondary") {
    throw new Error("Unknown artifact review priority.");
  }
  validateCaptureOutcome(artifact);
  validateTimestamp(`${testId}.${artifact.id}.capturedAt`, artifact.capturedAt);
  validateDuration(`${testId}.${artifact.id}.durationMs`, artifact.durationMs ?? 0);
  if (!contentTypes[artifact.kind].includes(artifact.contentType)) {
    throw new Error(`${artifact.id} has an invalid content type for its artifact kind.`);
  }
  const stepIds = new Set(steps.map((step) => step.id));
  if (artifact.stepId !== undefined && !stepIds.has(artifact.stepId)) {
    throw new Error(`${artifact.id} references unknown step ${artifact.stepId}.`);
  }
  for (const related of artifact.relatedArtifactIds ?? []) {
    validateIdentifier("related artifact id", related);
  }
}

function validateCaptureOutcome(artifact: SourceArtifact): void {
  if (artifact.captureStatus === "captured") {
    if (artifact.sourcePath === undefined) {
      throw new Error(`${artifact.id} is captured but has no source path.`);
    }
    validateNonEmpty("artifact source path", artifact.sourcePath);
    if (artifact.captureError !== undefined) {
      throw new Error(`${artifact.id} is captured and must not include a capture error.`);
    }
  } else if (artifact.sourcePath !== undefined) {
    throw new Error(`${artifact.id} must not expose a source path when capture did not succeed.`);
  }
  if (artifact.captureStatus === "captureFailed" && artifact.captureError === undefined) {
    throw new Error(`${artifact.id} must explain why capture failed.`);
  }
}
