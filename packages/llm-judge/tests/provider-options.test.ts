import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnthropicJudgeProvider,
  createOpenAICompatibleJudgeProvider,
  JudgeContractError,
} from "../src/index.js";

test("provider options reject accessors without executing them", () => {
  let getterCalled = false;
  const options = Object.defineProperty({}, "model", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "must-not-run";
    },
  });

  assert.throws(
    () => createOpenAICompatibleJudgeProvider(options as { model: string }),
    (error) => error instanceof JudgeContractError && /data property/.test(error.message),
  );
  assert.equal(getterCalled, false);
});

test("provider options reject Proxy objects without invoking traps", () => {
  let trapCalled = false;
  const options = new Proxy({ model: "must-not-run" }, {
    ownKeys() {
      trapCalled = true;
      return ["model"];
    },
  });

  assert.throws(
    () => createAnthropicJudgeProvider(options),
    (error) => error instanceof JudgeContractError && /Proxy/.test(error.message),
  );
  assert.equal(trapCalled, false);
});

test("provider options reject credentials embedded in a gateway URL", () => {
  assert.throws(
    () => createOpenAICompatibleJudgeProvider({
      model: "gateway-model",
      baseURL: "https://user:secret@example.test/v1",
    }),
    /must not contain credentials/,
  );
  assert.throws(
    () => createOpenAICompatibleJudgeProvider({
      model: "gateway-model",
      baseURL: "http://api.example.test/v1",
    }),
    /must use HTTPS unless it targets loopback/,
  );
});

test("provider options reject invalid environment names and output limits", () => {
  assert.throws(
    () => createOpenAICompatibleJudgeProvider({ model: "gateway-model", apiKeyEnv: "BAD-NAME" }),
    /environment variable name/,
  );
  assert.throws(
    () => createAnthropicJudgeProvider({ model: "claude-test", maxOutputTokens: 0 }),
    /must be greater than zero/,
  );
  assert.throws(
    () => createAnthropicJudgeProvider({ model: "claude-test", maxOutputTokens: 32_769 }),
    /0 through 32768/,
  );
});
