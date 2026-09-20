import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeJudgeProvider,
  judge,
  JudgeContractError,
  JudgeProviderError,
  type JudgeProvider,
  type JudgeRequest,
} from "../src/index.js";
import { classified, request } from "./fixtures.js";

const future = () => Date.now() + 5_000;

test("returns a classified result while keeping facts and hypotheses separate", async () => {
  const provider = new FakeJudgeProvider([{
    kind: "return",
    expect: { serviceRunId: "run-1", rubricVersion: "routing-v1", evidenceIds: ["ev-1"] },
    output: classified(),
  }]);
  const outcome = await judge(provider, request(), { deadlineAt: future() });
  assert.equal(outcome.status, "classified");
  if (outcome.status === "classified") {
    assert.equal(outcome.label, "sign-up");
    assert.match(outcome.observedFacts[0]!.statement, /heading/i);
    assert.match(outcome.hypotheses[0]!.verificationNeeded, /routing inputs/i);
  }
});

test("preserves an explicit insufficient result", async () => {
  const output = {
    status: "insufficient",
    reason: "The capture omitted the route heading.",
    reasons: ["No route-specific content is visible."],
    evidenceRefs: ["ev-1"],
    observedFacts: [{
      kind: "observed", scope: "ui", statement: "Only a blank container is visible.", evidenceRefs: ["ev-1"],
    }],
    hypotheses: [],
    providerMetadata: { provider: "fake", model: "deterministic-v1" },
  };
  const outcome = await judge(new FakeJudgeProvider([{ kind: "return", output }]), request(), { deadlineAt: future() });
  assert.equal(outcome.status, "insufficient");
});

test("turns unknown labels and foreign evidence references into invalidResponse", async () => {
  const unknownLabel = await judge(
    new FakeJudgeProvider([{ kind: "return", output: classified("unknown-label") }]),
    request(),
    { deadlineAt: future() },
  );
  assert.deepEqual(
    unknownLabel.status === "providerFailure" && unknownLabel.failure.kind,
    "invalidResponse",
  );
  const foreign = classified();
  foreign.evidenceRefs = ["other-run-evidence"];
  const foreignRef = await judge(
    new FakeJudgeProvider([{ kind: "return", output: foreign }]),
    request(),
    { deadlineAt: future() },
  );
  assert.equal(foreignRef.status === "providerFailure" && foreignRef.failure.kind, "invalidResponse");
});

test("requires observed facts to cite outcome evidence", async () => {
  const output = classified();
  output.observedFacts = [{ kind: "observed", scope: "ui", statement: "Unsupported fact.", evidenceRefs: [] }];
  const outcome = await judge(
    new FakeJudgeProvider([{ kind: "return", output }]),
    request(),
    { deadlineAt: future() },
  );
  assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "invalidResponse");
});

test("rejects duplicate response references and verdict injection", async () => {
  const duplicate = classified();
  duplicate.evidenceRefs = ["ev-1", "ev-1"];
  const duplicateOutcome = await judge(
    new FakeJudgeProvider([{ kind: "return", output: duplicate }]),
    request(),
    { deadlineAt: future() },
  );
  assert.equal(duplicateOutcome.status === "providerFailure" && duplicateOutcome.failure.kind, "invalidResponse");

  const injected = { ...classified(), verdict: "passed" };
  const injectedOutcome = await judge(
    new FakeJudgeProvider([{ kind: "return", output: injected }]),
    request(),
    { deadlineAt: future() },
  );
  assert.equal(injectedOutcome.status === "providerFailure" && injectedOutcome.failure.kind, "invalidResponse");
});

test("maps scripted provider failures without classifying", async () => {
  const outcome = await judge(new FakeJudgeProvider([{
    kind: "throw",
    failureKind: "rateLimited",
    message: "quota unavailable",
    retryable: true,
  }]), request(), { deadlineAt: future() });
  assert.equal(outcome.status, "providerFailure");
  if (outcome.status === "providerFailure") {
    assert.equal(outcome.failure.kind, "rateLimited");
    assert.equal(outcome.failure.retryable, true);
    assert.deepEqual(outcome.providerMetadata, { provider: "fake", model: "deterministic-script-v1" });
  }
});

test("pre-abort and elapsed deadline do not invoke the provider", async () => {
  const abort = new AbortController();
  abort.abort();
  const provider = new FakeJudgeProvider([{ kind: "return", output: classified() }]);
  const aborted = await judge(provider, request(), { deadlineAt: future(), signal: abort.signal });
  assert.equal(aborted.status === "providerFailure" && aborted.failure.kind, "aborted");
  const expired = await judge(provider, request(), { deadlineAt: Date.now() - 1 });
  assert.equal(expired.status === "providerFailure" && expired.failure.kind, "deadlineExceeded");
  assert.equal(provider.calls.length, 0);
});

test("aborts an in-flight provider through the shared signal", async () => {
  const abort = new AbortController();
  const provider = new FakeJudgeProvider([{ kind: "waitForAbort" }]);
  const pending = judge(provider, request(), { deadlineAt: future(), signal: abort.signal });
  abort.abort();
  const outcome = await pending;
  assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "aborted");
  assert.equal(provider.calls.length, 0);
});

test("deadline bounds a non-completing provider", async () => {
  const provider = new FakeJudgeProvider([{ kind: "waitForAbort" }]);
  const outcome = await judge(provider, request(), { deadlineAt: Date.now() + 25 });
  assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "deadlineExceeded");
});

test("fake script is reproducible after reset and isolates mutation", async () => {
  const source = classified();
  const provider = new FakeJudgeProvider([{ kind: "return", output: source }]);
  source.label = "sign-in";
  const first = await judge(provider, request(), { deadlineAt: future() });
  provider.reset();
  const second = await judge(provider, request(), { deadlineAt: future() });
  assert.deepEqual(second, first);
  assert.equal(provider.calls.length, 1);
});

test("Fake binds provenance instead of trusting scripted vendor metadata", async () => {
  const output = classified();
  output.providerMetadata = { provider: "real-vendor", model: "expensive-model", requestId: "forged" };
  const provider = new FakeJudgeProvider([{ kind: "return", output }]);
  const outcome = await judge(provider, request(), { deadlineAt: future() });
  assert.equal(outcome.status, "classified");
  if (outcome.status === "classified") {
    assert.deepEqual(outcome.providerMetadata, { provider: "fake", model: "deterministic-script-v1" });
  }
});

test("Fake failure provenance is isolated across reset", async () => {
  const provider = new FakeJudgeProvider([{
    kind: "throw", failureKind: "server", message: "Authorization: Bearer secret", retryable: true,
  }]);
  const first = await judge(provider, request(), { deadlineAt: future() });
  assert.equal(first.status, "providerFailure");
  if (first.status === "providerFailure" && first.providerMetadata !== undefined) {
    (first.providerMetadata as { provider: string }).provider = "mutated";
    assert.doesNotMatch(first.failure.message, /secret|Bearer/);
  }
  provider.reset();
  const second = await judge(provider, request(), { deadlineAt: future() });
  assert.equal(second.status, "providerFailure");
  if (second.status === "providerFailure") {
    assert.deepEqual(second.providerMetadata, { provider: "fake", model: "deterministic-script-v1" });
  }
});

test("late synchronous providers cannot classify after the absolute deadline", async () => {
  let calls = 0;
  const provider = {
    name: "blocking",
    judge() {
      calls += 1;
      const until = Date.now() + 15;
      while (Date.now() < until) { /* deliberately blocks timer delivery */ }
      return classified();
    },
  } as unknown as JudgeProvider;
  const outcome = await judge(provider, request(), { deadlineAt: Date.now() + 2 });
  assert.equal(calls, 1);
  assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "deadlineExceeded");
});

test("abort raised by the provider before return cannot classify", async () => {
  const abort = new AbortController();
  const provider: JudgeProvider = {
    name: "aborter",
    async judge() {
      abort.abort();
      return classified();
    },
  };
  const outcome = await judge(provider, request(), { deadlineAt: future(), signal: abort.signal });
  assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "aborted");
});

test("provider error getters and credential-like messages never escape", async () => {
  let reads = 0;
  const hostile = Object.create(JudgeProviderError.prototype) as Record<string, unknown>;
  Object.defineProperty(hostile, "kind", { get() { reads += 1; throw new Error("credential"); } });
  Object.defineProperty(hostile, "message", { value: "api_key=secret-token" });
  Object.defineProperty(hostile, "retryable", { value: false });
  const provider: JudgeProvider = { name: "hostile", async judge() { throw hostile; } };
  const outcome = await judge(provider, request(), { deadlineAt: future() });
  assert.equal(outcome.status, "providerFailure");
  if (outcome.status === "providerFailure") {
    assert.equal(outcome.failure.message, "Provider invocation failed");
    assert.doesNotMatch(outcome.failure.message, /secret|api_key/);
  }
  assert.equal(reads, 0);
});

test("structured provider failures cannot pass through credential-like messages", async () => {
  const output = {
    status: "providerFailure",
    failure: { kind: "authentication", message: "Authorization: Bearer secret-token", retryable: false },
    providerMetadata: { provider: "forged", model: "forged" },
  };
  const outcome = await judge(new FakeJudgeProvider([{ kind: "return", output }]), request(), { deadlineAt: future() });
  assert.equal(outcome.status, "providerFailure");
  if (outcome.status === "providerFailure") {
    assert.equal(outcome.failure.message, "Provider authentication failed");
    assert.doesNotMatch(outcome.failure.message, /Bearer|secret/);
  }
});

test("invalid caller input throws before invoking provider", async () => {
  const provider = new FakeJudgeProvider([{ kind: "return", output: classified() }]);
  const invalid = { ...request(), evidence: [request().evidence[0], request().evidence[0]] } as JudgeRequest;
  await assert.rejects(() => judge(provider, invalid, { deadlineAt: future() }), JudgeContractError);
  assert.equal(provider.calls.length, 0);
});
