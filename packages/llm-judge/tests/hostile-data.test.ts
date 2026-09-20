import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeJudgeProvider,
  JUDGE_LIMITS,
  JudgeContractError,
  judge,
  normalizeJudgeRequest,
  type JudgeProvider,
  type JudgeRequest,
} from "../src/index.js";
import { classified, request } from "./fixtures.js";

const future = () => Date.now() + 5_000;

test("request validation rejects getters without executing them", () => {
  let reads = 0;
  const hostile = { ...request() };
  Object.defineProperty(hostile, "question", { enumerable: true, get() { reads += 1; throw new Error("executed"); } });
  assert.throws(() => normalizeJudgeRequest(hostile), JudgeContractError);
  assert.equal(reads, 0);
});

test("request validation rejects Proxy traps without executing them", () => {
  let traps = 0;
  const hostile = new Proxy(request(), {
    get() { traps += 1; throw new Error("executed"); },
    ownKeys() { traps += 1; throw new Error("executed"); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error("executed"); },
  });
  assert.throws(() => normalizeJudgeRequest(hostile), JudgeContractError);
  assert.equal(traps, 0);
});

test("rejects sparse arrays, abnormal prototypes, depth, and byte budget abuse", () => {
  const sparse = new Array(2);
  sparse[0] = "sign-in";
  assert.throws(() => normalizeJudgeRequest({ ...request(), allowedLabels: sparse }), JudgeContractError);

  const abnormal = Object.assign(Object.create({ inherited: true }), request());
  assert.throws(() => normalizeJudgeRequest(abnormal), JudgeContractError);

  let deep: Record<string, unknown> = {};
  for (let index = 0; index < 20; index += 1) deep = { child: deep };
  assert.throws(() => normalizeJudgeRequest({ ...request(), extra: deep }), /depth budget/);
  assert.throws(
    () => normalizeJudgeRequest({ ...request(), question: "x".repeat(20 * 1024 * 1024 + 1) }),
    /byte budget/,
  );
  assert.throws(
    () => normalizeJudgeRequest({ ...request(), allowedLabels: new Array(20_001).fill("label") }),
    /node budget/,
  );
});

test("provider response getters and proxies fail closed without executing", async () => {
  let getterReads = 0;
  const getterOutput = { ...classified() };
  Object.defineProperty(getterOutput, "label", {
    enumerable: true,
    get() { getterReads += 1; throw new Error("credential=secret"); },
  });
  const getterProvider: JudgeProvider = { name: "hostile", async judge() { return getterOutput; } };
  const getterResult = await judge(getterProvider, request(), { deadlineAt: future() });
  assert.equal(getterResult.status === "providerFailure" && getterResult.failure.kind, "invalidResponse");
  assert.equal(getterReads, 0);

  let proxyTraps = 0;
  const proxyOutput = new Proxy(classified(), {
    get() { proxyTraps += 1; throw new Error("executed"); },
    ownKeys() { proxyTraps += 1; throw new Error("executed"); },
  });
  const proxyProvider = { name: "hostile", judge() { return proxyOutput; } } as unknown as JudgeProvider;
  const proxyResult = await judge(proxyProvider, request(), { deadlineAt: future() });
  assert.equal(proxyResult.status === "providerFailure" && proxyResult.failure.kind, "invalidResponse");
  assert.equal(proxyTraps, 0);
});

test("Fake rejects hostile scripts before any getter executes", () => {
  let reads = 0;
  const output = { ...classified() };
  Object.defineProperty(output, "label", { enumerable: true, get() { reads += 1; return "sign-up"; } });
  assert.throws(
    () => new FakeJudgeProvider([{ kind: "return", output }]),
    JudgeContractError,
  );
  assert.equal(reads, 0);

  let proxyTraps = 0;
  const proxyScript = new Proxy([{ kind: "return", output: classified() }], {
    get() { proxyTraps += 1; throw new Error("executed"); },
    ownKeys() { proxyTraps += 1; throw new Error("executed"); },
  });
  assert.throws(() => new FakeJudgeProvider(proxyScript as never), JudgeContractError);
  assert.equal(proxyTraps, 0);
  assert.throws(() => new FakeJudgeProvider(new Array(2) as never), JudgeContractError);
});

test("outcome validation rejects sparse, abnormal, and over-budget data", async () => {
  const sparse = classified();
  sparse.reasons = new Array(1);
  const abnormal = Object.assign(Object.create({ inherited: true }), classified());
  const oversized = { ...classified(), reasons: ["x".repeat(2 * 1024 * 1024 + 1)] };
  for (const output of [sparse, abnormal, oversized]) {
    const provider = { name: "hostile", judge() { return output; } } as unknown as JudgeProvider;
    const outcome = await judge(provider, request(), { deadlineAt: future() });
    assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "invalidResponse");
  }
});

test("canonical base64 handles the 5 MiB boundary and rejects non-canonical padding bits", () => {
  const bytes = Buffer.alloc(JUDGE_LIMITS.maxImageBytesPerEvidence, 0xa5);
  const image = {
    kind: "image" as const,
    evidenceId: "image-1",
    serviceRunId: "run-1",
    origin: { kind: "serviceArtifact" as const, artifactId: "shot-1" },
    mediaType: "image/png" as const,
    byteLength: bytes.length,
    dataBase64: bytes.toString("base64"),
  };
  assert.equal(normalizeJudgeRequest(request({ evidence: [image] })).evidence[0]?.kind, "image");
  assert.throws(
    () => normalizeJudgeRequest(request({ evidence: [{ ...image, byteLength: 1, dataBase64: "AB==" }] })),
    /canonical base64/,
  );
});

test("provider receives an isolated frozen request and cannot alter validation baseline", async () => {
  let frozen = false;
  const provider: JudgeProvider = {
    name: "mutator",
    async judge(input) {
      frozen = Object.isFrozen(input) && Object.isFrozen(input.allowedLabels) && Object.isFrozen(input.evidence[0]);
      assert.throws(() => (input.allowedLabels as string[]).push("forged"));
      return classified("forged");
    },
  };
  const outcome = await judge(provider, request(), { deadlineAt: future() });
  assert.equal(frozen, true);
  assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "invalidResponse");
});

test("a classified result requires current evidence, references, and observed facts", async () => {
  const noEvidence = request({ evidence: [] });
  const emptySupport = { ...classified(), evidenceRefs: [], observedFacts: [] };
  const first = await judge(new FakeJudgeProvider([{ kind: "return", output: emptySupport }]), noEvidence, { deadlineAt: future() });
  assert.equal(first.status === "providerFailure" && first.failure.kind, "invalidResponse");
  const second = await judge(new FakeJudgeProvider([{ kind: "return", output: emptySupport }]), request(), { deadlineAt: future() });
  assert.equal(second.status === "providerFailure" && second.failure.kind, "invalidResponse");

  const insufficient = {
    status: "insufficient",
    reason: "No evidence was supplied.",
    reasons: ["The question cannot be answered without evidence."],
    evidenceRefs: [],
    observedFacts: [],
    hypotheses: [],
    providerMetadata: { provider: "forged", model: "forged" },
  };
  const third = await judge(new FakeJudgeProvider([{ kind: "return", output: insufficient }]), noEvidence, { deadlineAt: future() });
  assert.equal(third.status, "insufficient");
});

test("backend claims are only accepted as hypotheses", async () => {
  const output = classified();
  output.observedFacts[0]!.scope = "backend";
  const outcome = await judge(new FakeJudgeProvider([{ kind: "return", output }]), request(), { deadlineAt: future() });
  assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "invalidResponse");
});
