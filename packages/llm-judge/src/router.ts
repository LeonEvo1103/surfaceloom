import {
  type JudgeInvocation,
  type JudgeOutcome,
  type JudgeProvider,
  type JudgeRequest,
  type ProviderFailureKind,
} from "./contracts.js";
import { snapshotInvocation } from "./invocation.js";
import { judge } from "./judge.js";
import { normalizeJudgeRequest } from "./request-validation.js";
import { normalizeRouter, type PreparedCandidate } from "./router-config.js";
import { identifier } from "./validation-primitives.js";

export type BuiltInJudgeProfileProvider = "openai-compatible" | "anthropic";
export type JudgeProfileProvider = BuiltInJudgeProfileProvider | "registered";

export interface BuiltInJudgeProfileConfig {
  readonly provider: BuiltInJudgeProfileProvider;
  readonly apiKeyEnv: string;
  readonly baseURL?: string;
  readonly models: readonly string[];
  readonly maxOutputTokens?: number;
}

export interface RegisteredJudgeProfileConfig {
  readonly provider: "registered";
  /** References trusted code supplied separately through JudgeRouterOptions. */
  readonly providerId: string;
}

export type JudgeProfileConfig = BuiltInJudgeProfileConfig | RegisteredJudgeProfileConfig;

export interface JudgeRouteCandidate {
  readonly profileId: string;
  /** Required for built-in API profiles and omitted for registered providers. */
  readonly model?: string;
}

export interface JudgeRouterConfig {
  readonly profiles: Readonly<Record<string, JudgeProfileConfig>>;
  readonly routes: Readonly<Record<string, readonly JudgeRouteCandidate[]>>;
}

export interface JudgeRoutingAttempt {
  readonly profileId: string;
  readonly provider: JudgeProfileProvider;
  readonly model?: string;
  readonly providerId?: string;
  readonly disposition: "selected" | "fallback" | "failed";
  readonly failureKind?: ProviderFailureKind;
}

export interface RoutedJudgeResult {
  readonly routeId: string;
  readonly outcome: JudgeOutcome;
  readonly attempts: readonly JudgeRoutingAttempt[];
}

export interface JudgeRouter {
  classify(
    routeId: string,
    request: JudgeRequest,
    invocation: JudgeInvocation,
  ): Promise<RoutedJudgeResult>;
  /** Adapts one configured route to the provider interface expected by Case runners. */
  provider(routeId: string): JudgeProvider;
}

export interface JudgeRouterOptions {
  /** Trusted application code. IDs are referenced by data-only router profiles. */
  readonly providers?: Readonly<Record<string, JudgeProvider>>;
}

export function createJudgeRouter(
  config: JudgeRouterConfig,
  options: JudgeRouterOptions = {},
): JudgeRouter {
  const normalized = normalizeRouter(config, options.providers);
  const providers = new Map<string, JudgeProvider>();

  const resolveRoute = (routeId: string): { id: string; candidates: readonly PreparedCandidate[] } => {
    const id = identifier(routeId, "routeId");
    const candidates = normalized.routes.get(id);
    if (candidates === undefined) throw new Error(`Unknown Judge route: ${id}.`);
    return { id, candidates };
  };

  const classify = async (
    routeId: string,
    request: JudgeRequest,
    invocation: JudgeInvocation,
  ): Promise<RoutedJudgeResult> => {
    const route = resolveRoute(routeId);
    const fixedRequest = normalizeJudgeRequest(request);
    const fixedInvocation = snapshotInvocation(invocation);
    const attempts: JudgeRoutingAttempt[] = [];
    let outcome: JudgeOutcome | undefined;

    for (let index = 0; index < route.candidates.length; index += 1) {
      const candidate = route.candidates[index]!;
      outcome = await judge(candidate.provider, fixedRequest, fixedInvocation);
      const hasNext = index + 1 < route.candidates.length;
      const fallback = hasNext && shouldFallback(outcome);
      attempts.push(Object.freeze({
        profileId: candidate.profileId,
        provider: candidate.providerKind,
        ...(candidate.model === undefined ? {} : { model: candidate.model }),
        ...(candidate.providerId === undefined ? {} : { providerId: candidate.providerId }),
        disposition: fallback ? "fallback" : outcome.status === "providerFailure" ? "failed" : "selected",
        ...(outcome.status === "providerFailure" ? { failureKind: outcome.failure.kind } : {}),
      }));
      if (!fallback) break;
    }

    if (outcome === undefined) throw new Error(`Judge route ${route.id} has no candidates.`);
    return Object.freeze({
      routeId: route.id,
      outcome,
      attempts: Object.freeze(attempts),
    });
  };

  return Object.freeze({
    classify,
    provider: (routeId: string): JudgeProvider => {
      const route = resolveRoute(routeId);
      const existing = providers.get(route.id);
      if (existing !== undefined) return existing;
      const provider = Object.freeze({
        name: `judge-router:${route.id}`,
        judge: async (request: JudgeRequest, context: { deadlineAt: number; signal: AbortSignal }) =>
          (await classify(route.id, request, context)).outcome,
      });
      providers.set(route.id, provider);
      return provider;
    },
  });
}

function shouldFallback(outcome: JudgeOutcome): boolean {
  return outcome.status === "providerFailure"
    && outcome.failure.retryable
    && (outcome.failure.kind === "rateLimited" || outcome.failure.kind === "server");
}
