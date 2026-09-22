import { types } from "node:util";
import {
  type JudgeProviderContext,
  JudgeProviderError,
  type ProviderMetadata,
  type ProviderUsage,
} from "../contracts.js";
import {
  exactKeys,
  finiteInteger,
  record,
  sanitizeUntrusted,
  text,
} from "../validation-primitives.js";

const OPTION_BUDGET = Object.freeze({ maxDepth: 4, maxNodes: 32, maxBytes: 8_192 });

export interface ProviderOptions {
  readonly model: string;
  readonly baseURL?: string;
  readonly apiKeyEnv?: string;
  readonly maxOutputTokens?: number;
}

export interface NormalizedProviderOptions {
  readonly model: string;
  readonly baseURL?: string;
  readonly apiKeyEnv: string;
  readonly maxOutputTokens: number;
}

function baseURL(value: unknown, path: string): string {
  const raw = text(value, path, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError(`${path} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError(`${path} must use HTTP or HTTPS`);
  }
  if (parsed.protocol === "http:" && !["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)) {
    throw new TypeError(`${path} must use HTTPS unless it targets loopback`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError(`${path} must not contain credentials`);
  }
  return raw.replace(/\/+$/, "");
}

export function normalizeProviderOptions(
  value: ProviderOptions,
  path: string,
  defaultApiKeyEnv: string,
): NormalizedProviderOptions {
  const input = record(sanitizeUntrusted(value, path, OPTION_BUDGET), path);
  exactKeys(input, ["model", "baseURL", "apiKeyEnv", "maxOutputTokens"], path);
  const envName = input.apiKeyEnv === undefined
    ? defaultApiKeyEnv
    : text(input.apiKeyEnv, `${path}.apiKeyEnv`, 128);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new TypeError(`${path}.apiKeyEnv must be an environment variable name`);
  }
  const tokenLimit = input.maxOutputTokens === undefined
    ? 4_096
    : finiteInteger(input.maxOutputTokens, `${path}.maxOutputTokens`, 32_768);
  if (tokenLimit === 0) throw new TypeError(`${path}.maxOutputTokens must be greater than zero`);
  return Object.freeze({
    model: text(input.model, `${path}.model`, 256),
    ...(input.baseURL === undefined ? {} : { baseURL: baseURL(input.baseURL, `${path}.baseURL`) }),
    apiKeyEnv: envName,
    maxOutputTokens: tokenLimit,
  });
}

export function apiKeyFromEnvironment(envName: string, metadata: ProviderMetadata): string {
  const value = process.env[envName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new JudgeProviderError("authentication", "Provider API key is unavailable", false, metadata);
  }
  return value.trim();
}

export function remainingTimeout(context: JudgeProviderContext): number {
  return Math.max(1, context.deadlineAt - Date.now());
}

export function ensureProviderCanDispatch(context: JudgeProviderContext): void {
  if (context.signal.aborted || Date.now() >= context.deadlineAt) {
    throw new Error("Provider dispatch was cancelled");
  }
}

export function providerMetadata(
  provider: string,
  model: string,
  startedAt: number,
  requestId?: string,
  usage?: ProviderUsage,
): ProviderMetadata {
  return {
    provider,
    model,
    ...(requestId === undefined ? {} : { requestId }),
    latencyMs: Math.max(0, Date.now() - startedAt),
    ...(usage === undefined ? {} : { usage }),
  };
}

function numericStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || types.isProxy(error)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "status");
    return descriptor !== undefined && "value" in descriptor && Number.isSafeInteger(descriptor.value)
      ? descriptor.value as number
      : undefined;
  } catch {
    return undefined;
  }
}

export function throwMappedProviderError(error: unknown, metadata: ProviderMetadata): never {
  if (error instanceof JudgeProviderError) throw error;
  const status = numericStatus(error);
  if (status === 401 || status === 403) {
    throw new JudgeProviderError("authentication", "Provider authentication failed", false, metadata);
  }
  if (status === 429) {
    throw new JudgeProviderError("rateLimited", "Provider rate limit was reached", true, metadata);
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    throw new JudgeProviderError("server", "Provider server failed", true, metadata);
  }
  throw new JudgeProviderError("provider", "Provider invocation failed", status === undefined, metadata);
}

export function requestId(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return fallback;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "_request_id");
    const candidate = descriptor !== undefined && "value" in descriptor ? descriptor.value : fallback;
    return typeof candidate === "string" && candidate.trim() !== "" ? candidate : fallback;
  } catch {
    return fallback;
  }
}
