import assert from "node:assert/strict";
import test from "node:test";

import {
  createJudgeRouter,
  judge,
  type JudgeRouterConfig,
} from "../src/index.js";
import { classified, request } from "./fixtures.js";
import { json, readJson, withServer } from "./provider-test-server.js";

const KEY_ONE_ENV = "SURFACELOOM_ROUTER_KEY_ONE";
const KEY_TWO_ENV = "SURFACELOOM_ROUTER_KEY_TWO";
const future = () => Date.now() + 5_000;

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

function response(text: string) {
  return {
    id: "resp-router-test",
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    model: "router-model",
    status: "completed",
    output: [{
      id: "msg-router-test",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function config(baseURL: string): JudgeRouterConfig {
  return {
    profiles: {
      key1: {
        provider: "openai-compatible",
        apiKeyEnv: KEY_ONE_ENV,
        baseURL,
        models: ["model-a", "model-b"],
      },
      key2: {
        provider: "openai-compatible",
        apiKeyEnv: KEY_TWO_ENV,
        baseURL,
        models: ["model-a", "model-c"],
      },
    },
    routes: {
      "login-default": [
        { profileId: "key1", model: "model-a" },
        { profileId: "key2", model: "model-a" },
      ],
      "login-fast": [{ profileId: "key1", model: "model-b" }],
      "login-deep": [{ profileId: "key2", model: "model-c" }],
    },
  };
}

test("routes one key to many models and one model across keys with bounded fallback", async () => {
  process.env[KEY_ONE_ENV] = "key-one";
  process.env[KEY_TWO_ENV] = "key-two";
  const calls: { authorization: string | undefined; model: unknown }[] = [];
  try {
    await withServer(async (incoming, outgoing) => {
      const body = await readJson(incoming) as Record<string, unknown>;
      const authorization = incoming.headers.authorization;
      calls.push({ authorization, model: body.model });
      if (authorization === "Bearer key-one" && body.model === "model-a") {
        json(outgoing, 429, { error: { message: "limited" } });
        return;
      }
      json(outgoing, 200, response(JSON.stringify(modelDecision())));
    }, async (baseURL) => {
      const router = createJudgeRouter(config(baseURL));
      const routed = await router.classify("login-default", request(), { deadlineAt: future() });
      assert.equal(routed.outcome.status, "classified");
      assert.deepEqual(routed.attempts, [
        {
          profileId: "key1",
          provider: "openai-compatible",
          model: "model-a",
          disposition: "fallback",
          failureKind: "rateLimited",
        },
        {
          profileId: "key2",
          provider: "openai-compatible",
          model: "model-a",
          disposition: "selected",
        },
      ]);

      assert.equal((await router.classify("login-fast", request(), {
        deadlineAt: future(),
      })).outcome.status, "classified");
      assert.equal((await router.classify("login-deep", request(), {
        deadlineAt: future(),
      })).outcome.status, "classified");
    });
    assert.deepEqual(calls, [
      { authorization: "Bearer key-one", model: "model-a" },
      { authorization: "Bearer key-two", model: "model-a" },
      { authorization: "Bearer key-one", model: "model-b" },
      { authorization: "Bearer key-two", model: "model-c" },
    ]);
  } finally {
    delete process.env[KEY_ONE_ENV];
    delete process.env[KEY_TWO_ENV];
  }
});

test("adapts a named route to the provider interface used by Case runners", async () => {
  process.env[KEY_ONE_ENV] = "key-one";
  process.env[KEY_TWO_ENV] = "key-two";
  try {
    const outcome = await withServer(async (_incoming, outgoing) => {
      json(outgoing, 200, response(JSON.stringify(modelDecision())));
    }, async (baseURL) => {
      const router = createJudgeRouter(config(baseURL));
      const first = router.provider("login-fast");
      assert.equal(first, router.provider("login-fast"));
      return await judge(first, request(), { deadlineAt: future() });
    });
    assert.equal(outcome.status, "classified");
  } finally {
    delete process.env[KEY_ONE_ENV];
    delete process.env[KEY_TWO_ENV];
  }
});

test("falls through after a retryable provider server failure", async () => {
  process.env[KEY_ONE_ENV] = "key-one";
  process.env[KEY_TWO_ENV] = "key-two";
  let calls = 0;
  try {
    const routed = await withServer(async (incoming, outgoing) => {
      calls += 1;
      if (incoming.headers.authorization === "Bearer key-one") {
        json(outgoing, 503, { error: { message: "temporarily unavailable" } });
        return;
      }
      json(outgoing, 200, response(JSON.stringify(modelDecision())));
    }, async (baseURL) => await createJudgeRouter(config(baseURL)).classify(
      "login-default",
      request(),
      { deadlineAt: future() },
    ));
    assert.equal(calls, 2);
    assert.equal(routed.outcome.status, "classified");
    assert.equal(routed.attempts[0]?.failureKind, "server");
    assert.equal(routed.attempts[0]?.disposition, "fallback");
  } finally {
    delete process.env[KEY_ONE_ENV];
    delete process.env[KEY_TWO_ENV];
  }
});

test("does not hide authentication or invalid-response failures behind another key", async () => {
  process.env[KEY_ONE_ENV] = "key-one";
  process.env[KEY_TWO_ENV] = "key-two";
  try {
    for (const mode of ["authentication", "invalid"] as const) {
      let calls = 0;
      const routed = await withServer(async (_incoming, outgoing) => {
        calls += 1;
        if (mode === "authentication") {
          json(outgoing, 401, { error: { message: "unauthorized" } });
        } else {
          json(outgoing, 200, response("not-json"));
        }
      }, async (baseURL) => await createJudgeRouter(config(baseURL)).classify(
        "login-default",
        request(),
        { deadlineAt: future() },
      ));
      assert.equal(calls, 1);
      assert.equal(routed.outcome.status, "providerFailure");
      assert.equal(routed.attempts.length, 1);
      assert.equal(routed.attempts[0]?.disposition, "failed");
      assert.equal(
        routed.outcome.status === "providerFailure" && routed.outcome.failure.kind,
        mode === "authentication" ? "authentication" : "invalidResponse",
      );
    }
  } finally {
    delete process.env[KEY_ONE_ENV];
    delete process.env[KEY_TWO_ENV];
  }
});

test("rejects secret values, unknown models, duplicate candidates and hostile config", () => {
  const base = config("http://127.0.0.1:12345");
  assert.throws(() => createJudgeRouter({
    ...base,
    profiles: { key1: { ...base.profiles.key1!, apiKey: "secret" } },
  } as unknown as JudgeRouterConfig), /apiKey.*not allowed/u);
  assert.throws(() => createJudgeRouter({
    ...base,
    routes: { bad: [{ profileId: "key1", model: "model-c" }] },
  }), /not allowed by profile/u);
  assert.throws(() => createJudgeRouter({
    ...base,
    routes: { bad: [
      { profileId: "key1", model: "model-a" },
      { profileId: "key1", model: "model-a" },
    ] },
  }), /duplicates/u);

  const getter = { profiles: base.profiles } as { profiles: JudgeRouterConfig["profiles"];
    routes?: JudgeRouterConfig["routes"] };
  Object.defineProperty(getter, "routes", { enumerable: true, get: () => base.routes });
  assert.throws(() => createJudgeRouter(getter as JudgeRouterConfig), /data property/u);
  assert.throws(() => createJudgeRouter(new Proxy(base, {}) as JudgeRouterConfig), /Proxy/u);
});
