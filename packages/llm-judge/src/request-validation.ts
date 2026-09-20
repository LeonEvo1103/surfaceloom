import {
  type EvidenceDescriptor,
  type EvidenceOrigin,
  JUDGE_LIMITS,
  type JudgeRequest,
  JudgeContractError,
} from "./contracts.js";
import {
  array,
  exactKeys,
  finiteInteger,
  identifier,
  record,
  REQUEST_DATA_BUDGET,
  sanitizeUntrusted,
  text,
  unique,
} from "./validation-primitives.js";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function normalizeOrigin(value: unknown, path: string): EvidenceOrigin {
  const input = record(value, path);
  exactKeys(input, ["kind", "artifactId"], path);
  if (input.kind !== "serviceArtifact") {
    throw new JudgeContractError(`${path}.kind`, "must be serviceArtifact");
  }
  return { kind: "serviceArtifact", artifactId: identifier(input.artifactId, `${path}.artifactId`) };
}

function decodedBytes(data: string, path: string): number {
  const decoded = Buffer.from(data, "base64");
  if (decoded.toString("base64") !== data) throw new JudgeContractError(path, "must be canonical base64");
  return decoded.byteLength;
}

function normalizeEvidence(value: unknown, path: string, serviceRunId: string): EvidenceDescriptor {
  const input = record(value, path);
  const evidenceId = identifier(input.evidenceId, `${path}.evidenceId`);
  const evidenceRunId = identifier(input.serviceRunId, `${path}.serviceRunId`);
  if (evidenceRunId !== serviceRunId) {
    throw new JudgeContractError(`${path}.serviceRunId`, "must match the current service run");
  }
  const origin = normalizeOrigin(input.origin, `${path}.origin`);
  if (input.kind === "text") {
    exactKeys(input, ["kind", "evidenceId", "serviceRunId", "origin", "contentType", "text"], path);
    if (input.contentType !== "text/plain") {
      throw new JudgeContractError(`${path}.contentType`, "must be text/plain");
    }
    return {
      kind: "text",
      evidenceId,
      serviceRunId: evidenceRunId,
      origin,
      contentType: "text/plain",
      text: text(input.text, `${path}.text`, JUDGE_LIMITS.maxTextCharsPerEvidence),
    };
  }
  if (input.kind === "image") {
    exactKeys(
      input,
      ["kind", "evidenceId", "serviceRunId", "origin", "mediaType", "byteLength", "dataBase64"],
      path,
    );
    if (typeof input.mediaType !== "string" || !IMAGE_TYPES.has(input.mediaType)) {
      throw new JudgeContractError(`${path}.mediaType`, "must be image/jpeg, image/png, or image/webp");
    }
    const byteLength = finiteInteger(
      input.byteLength,
      `${path}.byteLength`,
      JUDGE_LIMITS.maxImageBytesPerEvidence,
    );
    if (byteLength === 0) throw new JudgeContractError(`${path}.byteLength`, "must be greater than zero");
    if (typeof input.dataBase64 !== "string") {
      throw new JudgeContractError(`${path}.dataBase64`, "must be a base64 string");
    }
    const encodedLength = 4 * Math.ceil(byteLength / 3);
    if (input.dataBase64.length !== encodedLength) {
      throw new JudgeContractError(`${path}.dataBase64`, "length does not match declared image bytes");
    }
    if (decodedBytes(input.dataBase64, `${path}.dataBase64`) !== byteLength) {
      throw new JudgeContractError(`${path}.byteLength`, "does not match decoded image bytes");
    }
    return {
      kind: "image",
      evidenceId,
      serviceRunId: evidenceRunId,
      origin,
      mediaType: input.mediaType as "image/jpeg" | "image/png" | "image/webp",
      byteLength,
      dataBase64: input.dataBase64,
    };
  }
  throw new JudgeContractError(`${path}.kind`, "must be text or image");
}

export function normalizeJudgeRequest(value: unknown): JudgeRequest {
  const input = record(sanitizeUntrusted(value, "request", REQUEST_DATA_BUDGET), "request");
  exactKeys(input, ["serviceRunId", "rubricVersion", "question", "allowedLabels", "evidence"], "request");
  const serviceRunId = identifier(input.serviceRunId, "request.serviceRunId");
  const labels = array(input.allowedLabels, "request.allowedLabels", JUDGE_LIMITS.maxAllowedLabels)
    .map((label, index) => identifier(label, `request.allowedLabels[${index}]`));
  if (labels.length === 0) throw new JudgeContractError("request.allowedLabels", "must not be empty");
  unique(labels, "request.allowedLabels");
  const evidence = array(input.evidence, "request.evidence", JUDGE_LIMITS.maxEvidenceItems)
    .map((item, index) => normalizeEvidence(item, `request.evidence[${index}]`, serviceRunId));
  unique(evidence.map((item) => item.evidenceId), "request.evidence[].evidenceId");
  const totalText = evidence.reduce((sum, item) => sum + (item.kind === "text" ? item.text.length : 0), 0);
  const totalImages = evidence.reduce((sum, item) => sum + (item.kind === "image" ? item.byteLength : 0), 0);
  if (totalText > JUDGE_LIMITS.maxTotalTextChars) {
    throw new JudgeContractError("request.evidence", "exceeds total text limit");
  }
  if (totalImages > JUDGE_LIMITS.maxTotalImageBytes) {
    throw new JudgeContractError("request.evidence", "exceeds total image limit");
  }
  const normalized = {
    serviceRunId,
    rubricVersion: identifier(input.rubricVersion, "request.rubricVersion"),
    question: text(input.question, "request.question", JUDGE_LIMITS.maxQuestionChars),
    allowedLabels: labels,
    evidence,
  };
  return sanitizeUntrusted(normalized, "request", REQUEST_DATA_BUDGET) as JudgeRequest;
}
