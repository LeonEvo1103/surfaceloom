# SurfaceLoom LLM Judge

`@surfaceloom/llm-judge` classifies bounded evidence from the current test run.
It is an optional diagnostic or semantic assertion, not the owner of the test
verdict. A model cannot turn deterministic failures, incomplete evidence, or
cleanup failures into a passing Case.

## Providers

The package includes two adapters built on vendor-maintained SDKs:

- `createOpenAICompatibleJudgeProvider()` uses the OpenAI Responses API and
  also accepts a custom Responses-compatible `baseURL`.
- `createAnthropicJudgeProvider()` uses the native Anthropic Messages API.

Both adapters request JSON-schema structured output, inherit the Case deadline
and cancellation signal, disable SDK retries, record bounded provider metadata,
and map authentication, rate-limit, server, and malformed-response failures to
explicit non-passing outcomes.

The SDKs are optional peer dependencies. This package is not published to npm
yet. Build and pack the current checkout first:

```bash
git clone https://github.com/LeonEvo1103/surfaceloom.git
cd surfaceloom
npm ci --prefix packages/llm-judge
npm run --prefix packages/llm-judge build
npm pack ./packages/llm-judge --pack-destination /tmp
```

Then install the generated tarball and only the SDK needed by the consumer:

```bash
npm install /tmp/surfaceloom-llm-judge-0.1.0.tgz openai
# or
npm install /tmp/surfaceloom-llm-judge-0.1.0.tgz @anthropic-ai/sdk
```

## OpenAI or a Responses-compatible gateway

```ts
import {
  createOpenAICompatibleJudgeProvider,
  judge,
} from "@surfaceloom/llm-judge";

const provider = createOpenAICompatibleJudgeProvider({
  model: process.env.JUDGE_MODEL ?? "your-model-id",
  ...(process.env.JUDGE_BASE_URL === undefined
    ? {}
    : { baseURL: process.env.JUDGE_BASE_URL }),
  apiKeyEnv: "JUDGE_API_KEY",
});

const outcome = await judge(provider, {
  serviceRunId: "run-42",
  rubricVersion: "login-routing-v1",
  question: "Which login route is visible?",
  allowedLabels: ["sign-in", "sign-up", "unexpected-error"],
  evidence: [{
    kind: "text",
    evidenceId: "page-summary",
    serviceRunId: "run-42",
    origin: { kind: "serviceArtifact", artifactId: "artifact-17" },
    contentType: "text/plain",
    text: "Heading: Sign in. Alert: Email delivery failed.",
  }],
}, {
  deadlineAt: Date.now() + 15_000,
});
```

Omit `baseURL` for the standard OpenAI endpoint. A custom endpoint must support
the Responses API and JSON-schema structured output; Chat Completions-only
gateways are not assumed compatible.

## Anthropic

```ts
import {
  createAnthropicJudgeProvider,
  judge,
} from "@surfaceloom/llm-judge";

const provider = createAnthropicJudgeProvider({
  model: process.env.JUDGE_MODEL ?? "your-model-id",
  apiKeyEnv: "JUDGE_API_KEY",
});

const outcome = await judge(provider, request, {
  deadlineAt: Date.now() + 15_000,
});
```

## Multiple keys and models

`createJudgeRouter()` maps non-secret profile IDs to environment-backed provider
profiles. One profile may allow multiple models, and one model may appear under
multiple profiles:

```ts
import { createJudgeRouter } from "@surfaceloom/llm-judge";

const router = createJudgeRouter({
  profiles: {
    key1: {
      provider: "openai-compatible",
      apiKeyEnv: "JUDGE_KEY_1",
      baseURL: "https://api.example.test",
      models: ["model-a", "model-b"],
    },
    key2: {
      provider: "openai-compatible",
      apiKeyEnv: "JUDGE_KEY_2",
      baseURL: "https://api.example.test",
      models: ["model-a", "model-c"],
    },
  },
  routes: {
    "login-default": [
      { profileId: "key1", model: "model-a" },
      { profileId: "key2", model: "model-a" },
    ],
    "login-deep": [{ profileId: "key2", model: "model-c" }],
  },
});

const routed = await router.classify("login-default", request, {
  deadlineAt: Date.now() + 15_000,
});
console.log(routed.outcome, routed.attempts);

// Existing SurfaceLoom Case runners accept the same route as a JudgeProvider.
const provider = router.provider("login-default");
```

The configuration contains environment variable names, never credential
values. Routing falls through only after a retryable rate-limit or server
failure. Authentication, invalid responses, insufficient evidence, aborts, and
deadlines stop on the current candidate. `attempts` records non-secret profile,
provider, model, disposition, and failure kind for reporting.

## Custom and Agent-backed providers

`JudgeProvider` is the generic extension point. A provider may call an HTTP API,
a local Agent CLI, or a remote service; SurfaceLoom still validates its result
against the same evidence and outcome contract:

```ts
import {
  createJudgeRouter,
  type JudgeProvider,
} from "@surfaceloom/llm-judge";

const localReview: JudgeProvider = {
  name: "local-review",
  judge: async (request, context) => invokeYourAgent(request, context),
};

const router = createJudgeRouter({
  profiles: {
    agent: { provider: "registered", providerId: "local-review" },
  },
  routes: {
    "login-deep-review": [{ profileId: "agent" }],
  },
}, {
  providers: { "local-review": localReview },
});
```

The registry is trusted application code and remains separate from the
data-only router configuration. Registered profiles do not declare a fake API
key or model. Their implementation returns the provider/model metadata it can
actually prove.

The repository includes an optional
[`codex exec` example](https://github.com/LeonEvo1103/surfaceloom/blob/main/packages/llm-judge/examples/codex-exec-provider.ts). It is deliberately not
a new core provider type: it is one thin `JudgeProvider` binding that invokes
Codex non-interactively with a read-only sandbox, an ephemeral session, attached
image evidence, and the shared JSON Schema. Its contract tests use a local fake
CLI to verify structured output, deadline cancellation, owned-process exit, and
temporary-file cleanup without spending model tokens. A real Codex smoke remains
explicit and opt-in. See the
[official Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
for current CLI behavior.

If an external Agent already runs Cases through SurfaceLoom MCP and merely
needs to explain failures afterward, it can read the existing run result and
artifacts directly. That workflow does not need a nested Judge provider; use a
registered provider only when unattended execution must write the semantic
classification into the current Case report.

## Security and evidence boundary

- API keys are read only from the configured environment variable. They are
  never accepted in provider options, Case data, or report metadata.
- Evidence is copied, bounded, and treated as untrusted model input. Remote
  image URLs are not fetched; callers supply validated inline image bytes.
- Provider output is validated again locally. Unknown labels, foreign evidence
  references, missing observed support, or forged metadata fail closed.
- UI/artifact observations and backend hypotheses remain separate. A model
  cannot claim an invisible backend root cause as an observed fact.
- Real-provider tests are opt-in. Default tests use local protocol fixtures and
  do not require network access or credentials.

The adapters are intentionally small. Provider routing, secret distribution,
model allowlists, cost controls, and deployment authentication belong to the
embedding application.
