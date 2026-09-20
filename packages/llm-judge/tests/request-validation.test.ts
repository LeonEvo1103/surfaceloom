import assert from "node:assert/strict";
import test from "node:test";
import {
  JUDGE_LIMITS,
  JudgeContractError,
  normalizeJudgeRequest,
  type JudgeRequest,
} from "../src/index.js";
import { request } from "./fixtures.js";

test("normalizes explicit rubric fields and bounded text evidence", () => {
  const normalized = normalizeJudgeRequest({
    ...request(),
    question: "  Which route is visible?  ",
    evidence: [{ ...request().evidence[0], text: "  Heading: Create account  " }],
  });
  assert.equal(normalized.question, "Which route is visible?");
  assert.equal(normalized.evidence[0]?.kind, "text");
  if (normalized.evidence[0]?.kind === "text") assert.equal(normalized.evidence[0].text, "Heading: Create account");
});

test("accepts inline image bytes only when media type and declared size agree", () => {
  const bytes = Buffer.from([0, 1, 2, 3]);
  const normalized = normalizeJudgeRequest(request({
    evidence: [{
      kind: "image",
      evidenceId: "image-1",
      serviceRunId: "run-1",
      origin: { kind: "serviceArtifact", artifactId: "shot-1" },
      mediaType: "image/png",
      byteLength: bytes.length,
      dataBase64: bytes.toString("base64"),
    }],
  }));
  assert.equal(normalized.evidence[0]?.kind, "image");
});

test("rejects duplicate evidence and duplicate labels", () => {
  const one = request().evidence[0]!;
  assert.throws(
    () => normalizeJudgeRequest(request({ evidence: [one, { ...one, origin: { ...one.origin } }] })),
    (error: unknown) => error instanceof JudgeContractError && /duplicates/.test(error.message),
  );
  assert.throws(
    () => normalizeJudgeRequest(request({ allowedLabels: ["same", "same"] })),
    (error: unknown) => error instanceof JudgeContractError && /duplicates/.test(error.message),
  );
});

test("rejects evidence from another service run", () => {
  const crossRun = { ...request().evidence[0]!, serviceRunId: "run-2" };
  assert.throws(
    () => normalizeJudgeRequest(request({ evidence: [crossRun] as JudgeRequest["evidence"] })),
    (error: unknown) => error instanceof JudgeContractError && /current service run/.test(error.message),
  );
});

test("rejects remote locations and runner verdict injection", () => {
  const withUrl = { ...request().evidence[0]!, url: "https://example.invalid/secret.png" };
  assert.throws(
    () => normalizeJudgeRequest(request({ evidence: [withUrl] as JudgeRequest["evidence"] })),
    (error: unknown) => error instanceof JudgeContractError && /url: is not allowed/.test(error.message),
  );
  assert.throws(
    () => normalizeJudgeRequest({ ...request(), verdict: "passed" }),
    (error: unknown) => error instanceof JudgeContractError && /verdict: is not allowed/.test(error.message),
  );
});

test("rejects oversized and malformed evidence", () => {
  const oversized = { ...request().evidence[0]!, text: "x".repeat(JUDGE_LIMITS.maxTextCharsPerEvidence + 1) };
  assert.throws(() => normalizeJudgeRequest(request({ evidence: [oversized] as JudgeRequest["evidence"] })));
  const image = {
    kind: "image", evidenceId: "image-1", serviceRunId: "run-1",
    origin: { kind: "serviceArtifact", artifactId: "shot-1" },
    mediaType: "image/png", byteLength: 999, dataBase64: "AA==",
  };
  assert.throws(
    () => normalizeJudgeRequest(request({ evidence: [image] as JudgeRequest["evidence"] })),
    (error: unknown) => error instanceof JudgeContractError && /does not match/.test(error.message),
  );
  assert.throws(() => normalizeJudgeRequest(request({ evidence: [{ ...image, byteLength: 0, dataBase64: "" }] as JudgeRequest["evidence"] })));
});

test("fails closed on missing or illegal rubric fields", () => {
  const missingQuestion = { ...request() } as Record<string, unknown>;
  delete missingQuestion.question;
  assert.throws(() => normalizeJudgeRequest(missingQuestion), JudgeContractError);
  assert.throws(() => normalizeJudgeRequest(request({ allowedLabels: ["has spaces"] })), JudgeContractError);
});
