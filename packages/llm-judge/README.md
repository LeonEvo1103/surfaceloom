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
