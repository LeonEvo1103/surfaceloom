import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenAICompatibleJudgeProvider,
  judge,
  type JudgeRequest,
} from "../src/index.js";
import { classified, request } from "./fixtures.js";
import { json, readJson, withServer } from "./provider-test-server.js";

const KEY_ENV = "SURFACELOOM_TEST_OPENAI_KEY";
const future = () => Date.now() + 5_000;

function modelDecision(label = "sign-up") {
  const outcome = classified(label);
  return {
    status: outcome.status,
    label: outcome.label,
    confidence: outcome.confidence,
    reason: null,
    reasons: outcome.reasons,
    evidenceRefs: outcome.evidenceRefs,
    observedFacts: outcome.observedFacts,
    hypotheses: outcome.hypotheses,
  };
}

function response(text: string) {
  return {
    id: "resp-provider-test",
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    model: "gateway-model",
    output: [{
      id: "msg-provider-test",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: {
      input_tokens: 21,
      output_tokens: 12,
      total_tokens: 33,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

test("OpenAI-compatible adapter sends bounded structured multimodal input and binds provenance", async () => {
  process.env[KEY_ENV] = "test-openai-secret";
  let captured: { path?: string; authorization?: string; body?: unknown } = {};
  try {
    const outcome = await withServer(async (incoming, outgoing) => {
      captured = {
        path: incoming.url,
        authorization: incoming.headers.authorization,
        body: await readJson(incoming),
      };
      json(outgoing, 200, response(JSON.stringify(modelDecision())), { "x-request-id": "req-openai-test" });
    }, async (baseURL) => {
      const provider = createOpenAICompatibleJudgeProvider({
        model: "gateway-model",
        baseURL,
        apiKeyEnv: KEY_ENV,
      });
      const image = Buffer.from("image-bytes");
      const multimodal: JudgeRequest = request({
        evidence: [
          ...request().evidence,
          {
            kind: "image",
            evidenceId: "ev-image",
            serviceRunId: "run-1",
            origin: { kind: "serviceArtifact", artifactId: "artifact-image" },
            mediaType: "image/png",
            byteLength: image.byteLength,
            dataBase64: image.toString("base64"),
          },
        ],
      });
      return await judge(provider, multimodal, { deadlineAt: future() });
    });
    assert.equal(outcome.status, "classified");
    if (outcome.status === "classified") {
      assert.equal(outcome.providerMetadata.provider, "openai-compatible");
      assert.equal(outcome.providerMetadata.model, "gateway-model");
      assert.equal(outcome.providerMetadata.requestId, "req-openai-test");
      assert.deepEqual(outcome.providerMetadata.usage, { inputTokens: 21, outputTokens: 12, totalTokens: 33 });
      assert.equal(typeof outcome.providerMetadata.latencyMs, "number");
    }
    assert.equal(captured.path, "/responses");
    assert.equal(captured.authorization, "Bearer test-openai-secret");
    const body = captured.body as Record<string, any>;
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.text.format.schema.properties.label.anyOf[0].enum, ["sign-in", "sign-up"]);
    assert.match(JSON.stringify(body.input), /data:image\/png;base64/);
  } finally {
    delete process.env[KEY_ENV];
  }
});

test("OpenAI-compatible adapter fails closed for unknown labels", async () => {
  process.env[KEY_ENV] = "test-openai-secret";
  try {
    const outcome = await withServer(async (_incoming, outgoing) => {
      json(outgoing, 200, response(JSON.stringify(modelDecision("not-allowed"))));
    }, async (baseURL) => await judge(
      createOpenAICompatibleJudgeProvider({ model: "gateway-model", baseURL, apiKeyEnv: KEY_ENV }),
      request(),
      { deadlineAt: future() },
    ));
    assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "invalidResponse");
  } finally {
    delete process.env[KEY_ENV];
  }
});

for (const [status, expected, retryable] of [
  [401, "authentication", false],
  [429, "rateLimited", true],
  [503, "server", true],
] as const) {
  test(`OpenAI-compatible adapter maps HTTP ${status} without leaking credentials`, async () => {
    process.env[KEY_ENV] = "never-report-this-secret";
    try {
      const outcome = await withServer(async (_incoming, outgoing) => {
        json(outgoing, status, { error: { message: "Authorization: Bearer never-report-this-secret" } });
      }, async (baseURL) => await judge(
        createOpenAICompatibleJudgeProvider({ model: "gateway-model", baseURL, apiKeyEnv: KEY_ENV }),
        request(),
        { deadlineAt: future() },
      ));
      assert.equal(outcome.status, "providerFailure");
      if (outcome.status === "providerFailure") {
        assert.equal(outcome.failure.kind, expected);
        assert.equal(outcome.failure.retryable, retryable);
        assert.doesNotMatch(JSON.stringify(outcome), /never-report-this-secret|Bearer/);
      }
    } finally {
      delete process.env[KEY_ENV];
    }
  });
}

test("OpenAI-compatible adapter requires its configured environment key", async () => {
  delete process.env[KEY_ENV];
  const outcome = await judge(
    createOpenAICompatibleJudgeProvider({ model: "gateway-model", apiKeyEnv: KEY_ENV }),
    request(),
    { deadlineAt: future() },
  );
  assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "authentication");
});

test("OpenAI-compatible request is aborted by the judge deadline", async () => {
  process.env[KEY_ENV] = "test-openai-secret";
  try {
    const outcome = await withServer(async () => await new Promise<void>(() => {}), async (baseURL) => await judge(
      createOpenAICompatibleJudgeProvider({ model: "gateway-model", baseURL, apiKeyEnv: KEY_ENV }),
      request(),
      { deadlineAt: Date.now() + 30 },
    ));
    assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "deadlineExceeded");
  } finally {
    delete process.env[KEY_ENV];
  }
});
