import type { JudgeProvider } from "./contracts.js";
import {
  createAnthropicJudgeProvider,
  createOpenAICompatibleJudgeProvider,
  type ProviderOptions,
} from "./providers/index.js";
import type {
  BuiltInJudgeProfileConfig,
  BuiltInJudgeProfileProvider,
  JudgeRouteCandidate,
  JudgeRouterConfig,
} from "./router.js";
import {
  array,
  exactKeys,
  finiteInteger,
  identifier,
  record,
  sanitizeUntrusted,
  text,
  unique,
} from "./validation-primitives.js";

const ROUTER_BUDGET = Object.freeze({ maxDepth: 8, maxNodes: 4_096, maxBytes: 256 * 1024 });
const MAX_PROFILES = 64;
const MAX_MODELS_PER_PROFILE = 64;
const MAX_ROUTES = 128;
const MAX_CANDIDATES_PER_ROUTE = 16;

interface NormalizedBuiltInProfile extends BuiltInJudgeProfileConfig {
  readonly id: string;
}

interface NormalizedRegisteredProfile {
  readonly id: string;
  readonly provider: "registered";
  readonly providerId: string;
  readonly implementation: JudgeProvider;
}

type NormalizedProfile = NormalizedBuiltInProfile | NormalizedRegisteredProfile;

export interface PreparedCandidate extends JudgeRouteCandidate {
  readonly providerKind: BuiltInJudgeProfileProvider | "registered";
  readonly provider: JudgeProvider;
  readonly providerId?: string;
}

export interface NormalizedRouter {
  readonly routes: ReadonlyMap<string, readonly PreparedCandidate[]>;
}

export function normalizeRouter(
  value: JudgeRouterConfig,
  providerInput?: Readonly<Record<string, JudgeProvider>>,
): NormalizedRouter {
  const registeredProviders = normalizeRegisteredProviders(providerInput);
  const input = record(sanitizeUntrusted(value, "judgeRouter", ROUTER_BUDGET), "judgeRouter");
  exactKeys(input, ["profiles", "routes"], "judgeRouter");
  const profilesInput = record(input.profiles, "judgeRouter.profiles");
  const profileEntries = Object.entries(profilesInput);
  if (profileEntries.length === 0 || profileEntries.length > MAX_PROFILES) {
    throw new Error(`Judge router requires 1 through ${MAX_PROFILES} profiles.`);
  }
  const profiles = new Map<string, NormalizedProfile>();
  for (const [rawId, rawProfile] of profileEntries) {
    const id = identifier(rawId, `judgeRouter.profiles.${rawId}`);
    profiles.set(id, normalizeProfile(id, rawProfile, registeredProviders));
  }

  const routesInput = record(input.routes, "judgeRouter.routes");
  const routeEntries = Object.entries(routesInput);
  if (routeEntries.length === 0 || routeEntries.length > MAX_ROUTES) {
    throw new Error(`Judge router requires 1 through ${MAX_ROUTES} routes.`);
  }
  const routes = new Map<string, readonly PreparedCandidate[]>();
  for (const [rawId, rawCandidates] of routeEntries) {
    const routeId = identifier(rawId, `judgeRouter.routes.${rawId}`);
    const candidates = array(rawCandidates, `judgeRouter.routes.${routeId}`, MAX_CANDIDATES_PER_ROUTE);
    if (candidates.length === 0) throw new Error(`Judge route ${routeId} requires at least one candidate.`);
    const prepared = candidates.map((candidate, index) =>
      prepareCandidate(routeId, index, candidate, profiles));
    unique(prepared.map((item) => `${item.profileId}\u0000${item.model}`),
      `judgeRouter.routes.${routeId}`);
    routes.set(routeId, Object.freeze(prepared));
  }
  return Object.freeze({ routes });
}

function normalizeProfile(
  id: string,
  value: unknown,
  registeredProviders: ReadonlyMap<string, JudgeProvider>,
): NormalizedProfile {
  const path = `judgeRouter.profiles.${id}`;
  const input = record(value, path);
  if (input.provider === "registered") {
    exactKeys(input, ["provider", "providerId"], path);
    const providerId = identifier(input.providerId, `${path}.providerId`);
    const implementation = registeredProviders.get(providerId);
    if (implementation === undefined) {
      throw new Error(`${path}.providerId references an unknown registered provider.`);
    }
    return Object.freeze({ id, provider: "registered", providerId, implementation });
  }
  exactKeys(input, ["provider", "apiKeyEnv", "baseURL", "models", "maxOutputTokens"], path);
  if (input.provider !== "openai-compatible" && input.provider !== "anthropic") {
    throw new Error(`${path}.provider must be openai-compatible or anthropic.`);
  }
  const apiKeyEnv = text(input.apiKeyEnv, `${path}.apiKeyEnv`, 128);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
    throw new Error(`${path}.apiKeyEnv must be an environment variable name.`);
  }
  const models = array(input.models, `${path}.models`, MAX_MODELS_PER_PROFILE)
    .map((model, index) => text(model, `${path}.models[${index}]`, 256));
  if (models.length === 0) throw new Error(`${path}.models must not be empty.`);
  unique(models, `${path}.models`);
  const maxOutputTokens = input.maxOutputTokens === undefined
    ? undefined
    : finiteInteger(input.maxOutputTokens, `${path}.maxOutputTokens`, 32_768);
  if (maxOutputTokens === 0) throw new Error(`${path}.maxOutputTokens must be greater than zero.`);
  const baseURL = input.baseURL === undefined ? undefined : text(input.baseURL, `${path}.baseURL`, 2_048);
  createProvider(input.provider, providerOptions(models[0]!, apiKeyEnv, baseURL, maxOutputTokens));
  return Object.freeze({ id, provider: input.provider, apiKeyEnv, models: Object.freeze(models),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) });
}

function prepareCandidate(routeId: string, index: number, value: unknown,
  profiles: ReadonlyMap<string, NormalizedProfile>): PreparedCandidate {
  const path = `judgeRouter.routes.${routeId}[${index}]`;
  const input = record(value, path);
  exactKeys(input, ["profileId", "model"], path);
  const profileId = identifier(input.profileId, `${path}.profileId`);
  const profile = profiles.get(profileId);
  if (profile === undefined) throw new Error(`${path}.profileId references an unknown profile.`);
  if (profile.provider === "registered") {
    if (input.model !== undefined) throw new Error(`${path}.model is not allowed for a registered provider.`);
    return Object.freeze({
      profileId,
      providerKind: "registered",
      providerId: profile.providerId,
      provider: profile.implementation,
    });
  }
  const model = text(input.model, `${path}.model`, 256);
  if (!profile.models.includes(model)) throw new Error(`${path}.model is not allowed by profile ${profileId}.`);
  return Object.freeze({ profileId, model, providerKind: profile.provider,
    provider: createProvider(profile.provider,
      providerOptions(model, profile.apiKeyEnv, profile.baseURL, profile.maxOutputTokens)) });
}

function providerOptions(model: string, apiKeyEnv: string, baseURL?: string,
  maxOutputTokens?: number): ProviderOptions {
  return { model, apiKeyEnv, ...(baseURL === undefined ? {} : { baseURL }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) };
}

function createProvider(kind: BuiltInJudgeProfileProvider, options: ProviderOptions): JudgeProvider {
  return kind === "openai-compatible"
    ? createOpenAICompatibleJudgeProvider(options)
    : createAnthropicJudgeProvider(options);
}

function normalizeRegisteredProviders(
  input?: Readonly<Record<string, JudgeProvider>>,
): ReadonlyMap<string, JudgeProvider> {
  if (input === undefined) return new Map();
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Judge router providers must be a record.");
  }
  const providers = new Map<string, JudgeProvider>();
  for (const [rawId, provider] of Object.entries(input)) {
    const id = identifier(rawId, `judgeRouter.providers.${rawId}`);
    if (typeof provider !== "object" || provider === null || typeof provider.judge !== "function") {
      throw new TypeError(`judgeRouter.providers.${id} must implement JudgeProvider.`);
    }
    const name = identifier(provider.name, `judgeRouter.providers.${id}.name`);
    const invoke = provider.judge.bind(provider);
    providers.set(id, Object.freeze({ name, judge: invoke }));
  }
  return providers;
}
