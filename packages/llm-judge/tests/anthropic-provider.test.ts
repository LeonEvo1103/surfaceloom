import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropicJudgeProvider, judge } from "../src/index.js";
import { classified, request } from "./fixtures.js";
import { json, readJson, withServer } from "./provider-test-server.js";

const KEY_ENV = "SURFACELOOM_TEST_ANTHROPIC_KEY";

function modelDecision() {
  const outcome = classified();
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

test("Anthropic adapter uses native structured output while preserving the shared contract", async () => {
  process.env[KEY_ENV] = "test-anthropic-secret";
  let captured: { path?: string; apiKey?: string; body?: unknown } = {};
  try {
    const outcome = await withServer(async (incoming, outgoing) => {
      captured = {
        path: incoming.url,
        apiKey: incoming.headers["x-api-key"] as string | undefined,
        body: await readJson(incoming),
      };
      json(outgoing, 200, {
        id: "msg-anthropic-test",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: JSON.stringify(modelDecision()) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 30,
          output_tokens: 15,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
        },
      }, { "request-id": "req-anthropic-test" });
    }, async (baseURL) => await judge(
      createAnthropicJudgeProvider({ model: "claude-test", baseURL, apiKeyEnv: KEY_ENV }),
      request(),
      { deadlineAt: Date.now() + 5_000 },
    ));
    assert.equal(outcome.status, "classified");
    if (outcome.status === "classified") {
      assert.equal(outcome.providerMetadata.provider, "anthropic");
      assert.equal(outcome.providerMetadata.model, "claude-test");
      assert.equal(outcome.providerMetadata.requestId, "req-anthropic-test");
      assert.deepEqual(outcome.providerMetadata.usage, { inputTokens: 35, outputTokens: 15, totalTokens: 50 });
    }
    assert.equal(captured.path, "/v1/messages");
    assert.equal(captured.apiKey, "test-anthropic-secret");
    const body = captured.body as Record<string, any>;
    assert.equal(body.output_config.format.type, "json_schema");
    assert.deepEqual(body.output_config.format.schema.properties.status.enum, ["classified", "insufficient"]);
  } finally {
    delete process.env[KEY_ENV];
  }
});

for (const [status, errorType, expected, retryable] of [
  [401, "authentication_error", "authentication", false],
  [429, "rate_limit_error", "rateLimited", true],
  [503, "api_error", "server", true],
] as const) {
  test(`Anthropic adapter maps HTTP ${status} without leaking credentials`, async () => {
    process.env[KEY_ENV] = "never-report-this-secret";
    try {
      const outcome = await withServer(async (_incoming, outgoing) => {
        json(outgoing, status, {
          type: "error",
          error: {
            type: errorType,
            message: "x-api-key: never-report-this-secret",
          },
        });
      }, async (baseURL) => await judge(
        createAnthropicJudgeProvider({ model: "claude-test", baseURL, apiKeyEnv: KEY_ENV }),
        request(),
        { deadlineAt: Date.now() + 5_000 },
      ));
      assert.equal(outcome.status, "providerFailure");
      if (outcome.status === "providerFailure") {
        assert.equal(outcome.failure.kind, expected);
        assert.equal(outcome.failure.retryable, retryable);
        assert.doesNotMatch(JSON.stringify(outcome), /never-report-this-secret|x-api-key/);
      }
    } finally {
      delete process.env[KEY_ENV];
    }
  });
}

test("Anthropic adapter requires its configured environment key", async () => {
  delete process.env[KEY_ENV];
  const outcome = await judge(
    createAnthropicJudgeProvider({ model: "claude-test", apiKeyEnv: KEY_ENV }),
    request(),
    { deadlineAt: Date.now() + 5_000 },
  );
  assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "authentication");
});

test("Anthropic request is aborted by the judge deadline", async () => {
  process.env[KEY_ENV] = "test-anthropic-secret";
  try {
    const outcome = await withServer(async () => await new Promise<void>(() => {}), async (baseURL) => await judge(
      createAnthropicJudgeProvider({ model: "claude-test", baseURL, apiKeyEnv: KEY_ENV }),
      request(),
      { deadlineAt: Date.now() + 30 },
    ));
    assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "deadlineExceeded");
  } finally {
    delete process.env[KEY_ENV];
  }
});
