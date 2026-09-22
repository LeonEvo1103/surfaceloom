import type { ResponseInputContent, ResponseUsage } from "openai/resources/responses/responses";
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

function inputContent(request: JudgeRequest): ResponseInputContent[] {
  const content: ResponseInputContent[] = [{ type: "input_text", text: judgePrompt(request) }];
  for (const item of request.evidence) {
    if (item.kind !== "image") continue;
    content.push({ type: "input_text", text: `Image evidence ${item.evidenceId}:` });
    content.push({
      type: "input_image",
      detail: "auto",
      image_url: `data:${item.mediaType};base64,${item.dataBase64}`,
    });
  }
  return content;
}

function usage(value: ResponseUsage | null | undefined): ProviderUsage | undefined {
  if (value === null || value === undefined) return undefined;
  return {
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    totalTokens: value.total_tokens,
  };
}

/**
 * OpenAI Responses API adapter. It also supports gateways implementing that API.
 * Credentials are resolved only from the configured environment variable.
 */
export class OpenAICompatibleJudgeProvider implements JudgeProvider {
  readonly name = "openai-compatible";
  readonly #options: NormalizedProviderOptions;

  constructor(options: ProviderOptions) {
    this.#options = normalizeProviderOptions(options, "openAICompatible", "OPENAI_API_KEY");
  }

  async judge(request: JudgeRequest, context: JudgeProviderContext): Promise<unknown> {
    const startedAt = Date.now();
    const baseMetadata = providerMetadata(this.name, this.#options.model, startedAt);
    try {
      const apiKey = apiKeyFromEnvironment(this.#options.apiKeyEnv, baseMetadata);
      const { default: OpenAI } = await import("openai");
      ensureProviderCanDispatch(context);
      const client = new OpenAI({
        apiKey,
        ...(this.#options.baseURL === undefined ? {} : { baseURL: this.#options.baseURL }),
        maxRetries: 0,
        timeout: remainingTimeout(context),
      });
      const response = await client.responses.create({
        model: this.#options.model,
        instructions: judgeInstructions(),
        input: [{ role: "user", content: inputContent(request) }],
        max_output_tokens: this.#options.maxOutputTokens,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "surfaceloom_judge",
            strict: true,
            schema: judgeOutputSchema(request),
          },
        },
      }, {
        signal: context.signal,
        timeout: remainingTimeout(context),
        maxRetries: 0,
      });
      const metadata = providerMetadata(
        this.name,
        this.#options.model,
        startedAt,
        requestId(response, response.id),
        usage(response.usage),
      );
      return bindStructuredDecision(response.output_text, metadata);
    } catch (error) {
      throwMappedProviderError(
        error,
        providerMetadata(this.name, this.#options.model, startedAt),
      );
    }
  }
}

export function createOpenAICompatibleJudgeProvider(options: ProviderOptions): JudgeProvider {
  return new OpenAICompatibleJudgeProvider(options);
}
