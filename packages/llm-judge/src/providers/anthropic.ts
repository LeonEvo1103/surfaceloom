import type {
  ContentBlockParam,
  Usage,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  JudgeProvider,
  JudgeProviderContext,
  JudgeRequest,
  ProviderUsage,
} from "../contracts.js";
import {
  bindStructuredDecision,
  judgeInstructions,
  judgeOutputSchema,
  judgePrompt,
} from "./structured-output.js";
import {
  apiKeyFromEnvironment,
  ensureProviderCanDispatch,
  type NormalizedProviderOptions,
  normalizeProviderOptions,
  type ProviderOptions,
  providerMetadata,
  remainingTimeout,
  requestId,
  throwMappedProviderError,
} from "./provider-runtime.js";

function inputContent(request: JudgeRequest): ContentBlockParam[] {
  const content: ContentBlockParam[] = [{ type: "text", text: judgePrompt(request) }];
  for (const item of request.evidence) {
    if (item.kind !== "image") continue;
    content.push({ type: "text", text: `Image evidence ${item.evidenceId}:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: item.mediaType, data: item.dataBase64 },
    });
  }
  return content;
}

function usage(value: Usage): ProviderUsage {
  const inputTokens = value.input_tokens
    + (value.cache_creation_input_tokens ?? 0)
    + (value.cache_read_input_tokens ?? 0);
  return {
    inputTokens,
    outputTokens: value.output_tokens,
    totalTokens: inputTokens + value.output_tokens,
  };
}

/** Native Anthropic Messages API adapter using JSON-schema structured output. */
export class AnthropicJudgeProvider implements JudgeProvider {
  readonly name = "anthropic";
  readonly #options: NormalizedProviderOptions;

  constructor(options: ProviderOptions) {
    this.#options = normalizeProviderOptions(options, "anthropic", "ANTHROPIC_API_KEY");
  }

  async judge(request: JudgeRequest, context: JudgeProviderContext): Promise<unknown> {
    const startedAt = Date.now();
    const baseMetadata = providerMetadata(this.name, this.#options.model, startedAt);
    try {
      const apiKey = apiKeyFromEnvironment(this.#options.apiKeyEnv, baseMetadata);
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      ensureProviderCanDispatch(context);
      const client = new Anthropic({
        apiKey,
        ...(this.#options.baseURL === undefined ? {} : { baseURL: this.#options.baseURL }),
        maxRetries: 0,
        timeout: remainingTimeout(context),
      });
      const response = await client.messages.create({
        model: this.#options.model,
        max_tokens: this.#options.maxOutputTokens,
        system: judgeInstructions(),
        messages: [{ role: "user", content: inputContent(request) }],
        output_config: {
          format: { type: "json_schema", schema: judgeOutputSchema(request) },
        },
      }, {
        signal: context.signal,
        timeout: remainingTimeout(context),
        maxRetries: 0,
      });
      const output = response.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");
      const metadata = providerMetadata(
        this.name,
        this.#options.model,
        startedAt,
        requestId(response, response.id),
        usage(response.usage),
      );
      return bindStructuredDecision(output, metadata);
    } catch (error) {
      throwMappedProviderError(
        error,
        providerMetadata(this.name, this.#options.model, startedAt),
      );
    }
  }
}

export function createAnthropicJudgeProvider(options: ProviderOptions): JudgeProvider {
  return new AnthropicJudgeProvider(options);
}
