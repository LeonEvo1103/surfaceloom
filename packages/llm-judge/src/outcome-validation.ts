import {
  type Hypothesis,
  type JudgeOutcome,
  JUDGE_LIMITS,
  type ObservedFact,
  type ProviderMetadata,
  type ProviderUsage,
  type JudgeRequest,
  JudgeContractError,
} from "./contracts.js";
import {
  array,
  exactKeys,
  finiteInteger,
  OUTCOME_DATA_BUDGET,
  record,
  sanitizeUntrusted,
  text,
  unique,
} from "./validation-primitives.js";
import { normalizeJudgeRequest } from "./request-validation.js";

function refs(value: unknown, path: string, permitted: ReadonlySet<string>, allowEmpty: boolean): string[] {
  const result = array(value, path, JUDGE_LIMITS.maxEvidenceItems).map((item, index) => {
    const ref = text(item, `${path}[${index}]`, 128);
    if (!permitted.has(ref)) throw new JudgeContractError(`${path}[${index}]`, "does not reference request evidence");
    return ref;
  });
  if (!allowEmpty && result.length === 0) throw new JudgeContractError(path, "must not be empty");
  unique(result, path);
  return result;
}

function usage(value: unknown, path: string): ProviderUsage {
  const input = record(value, path);
  exactKeys(input, ["inputTokens", "outputTokens", "totalTokens"], path);
  const result: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (input[key] !== undefined) result[key] = finiteInteger(input[key], `${path}.${key}`);
  }
  return result;
}

function metadata(value: unknown, path: string): ProviderMetadata {
  const input = record(value, path);
  exactKeys(input, ["provider", "model", "requestId", "latencyMs", "usage"], path);
  const result: {
    provider: string;
    model: string;
    requestId?: string;
    latencyMs?: number;
    usage?: ProviderUsage;
  } = {
    provider: text(input.provider, `${path}.provider`, 128),
    model: text(input.model, `${path}.model`, 128),
  };
  if (input.requestId !== undefined) result.requestId = text(input.requestId, `${path}.requestId`, 256);
  if (input.latencyMs !== undefined) result.latencyMs = finiteInteger(input.latencyMs, `${path}.latencyMs`);
  if (input.usage !== undefined) result.usage = usage(input.usage, `${path}.usage`);
  return result;
}

function controlledFailureMessage(kind: string): string {
  switch (kind) {
    case "aborted": return "Judge invocation was aborted";
    case "deadlineExceeded": return "Judge deadline was exceeded";
    case "authentication": return "Provider authentication failed";
    case "rateLimited": return "Provider rate limit was reached";
    case "server": return "Provider server failed";
    case "invalidResponse": return "Provider response failed contract validation";
    default: return "Provider invocation failed";
  }
}

function facts(
  value: unknown,
  path: string,
  permitted: ReadonlySet<string>,
  outcomeRefs: ReadonlySet<string>,
): ObservedFact[] {
  return array(value, path, JUDGE_LIMITS.maxObservedFacts).map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const input = record(item, itemPath);
    exactKeys(input, ["kind", "scope", "statement", "evidenceRefs"], itemPath);
    if (input.kind !== "observed") throw new JudgeContractError(`${itemPath}.kind`, "must be observed");
    if (input.scope !== "ui" && input.scope !== "artifact") {
      throw new JudgeContractError(`${itemPath}.scope`, "must be ui or artifact; backend causes are hypotheses");
    }
    const evidenceRefs = refs(input.evidenceRefs, `${itemPath}.evidenceRefs`, permitted, false);
    if (evidenceRefs.some((ref) => !outcomeRefs.has(ref))) {
      throw new JudgeContractError(`${itemPath}.evidenceRefs`, "must be included in outcome evidenceRefs");
    }
    return {
      kind: "observed",
      scope: input.scope,
      statement: text(input.statement, `${itemPath}.statement`, 2_000),
      evidenceRefs,
    };
  });
}

function hypotheses(
  value: unknown,
  path: string,
  permitted: ReadonlySet<string>,
  outcomeRefs: ReadonlySet<string>,
): Hypothesis[] {
  return array(value, path, JUDGE_LIMITS.maxHypotheses).map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const input = record(item, itemPath);
    exactKeys(input, ["kind", "scope", "statement", "evidenceRefs", "verificationNeeded"], itemPath);
    if (input.kind !== "hypothesis") throw new JudgeContractError(`${itemPath}.kind`, "must be hypothesis");
    if (input.scope !== "ui" && input.scope !== "artifact" && input.scope !== "backend") {
      throw new JudgeContractError(`${itemPath}.scope`, "must be ui, artifact, or backend");
    }
    const evidenceRefs = refs(input.evidenceRefs, `${itemPath}.evidenceRefs`, permitted, true);
    if (evidenceRefs.some((ref) => !outcomeRefs.has(ref))) {
      throw new JudgeContractError(`${itemPath}.evidenceRefs`, "must be included in outcome evidenceRefs");
    }
    return {
      kind: "hypothesis",
      scope: input.scope,
      statement: text(input.statement, `${itemPath}.statement`, 2_000),
      evidenceRefs,
      verificationNeeded: text(input.verificationNeeded, `${itemPath}.verificationNeeded`, 2_000),
    };
  });
}

function support(input: Record<string, unknown>, request: JudgeRequest, required: boolean) {
  const permitted = new Set(request.evidence.map((item) => item.evidenceId));
  const evidenceRefs = refs(input.evidenceRefs, "outcome.evidenceRefs", permitted, !required);
  const outcomeRefs = new Set(evidenceRefs);
  const reasons = array(input.reasons, "outcome.reasons", JUDGE_LIMITS.maxReasons)
    .map((reason, index) => text(reason, `outcome.reasons[${index}]`, 2_000));
  if (reasons.length === 0) throw new JudgeContractError("outcome.reasons", "must not be empty");
  const observedFacts = facts(input.observedFacts, "outcome.observedFacts", permitted, outcomeRefs);
  if (required && observedFacts.length === 0) {
    throw new JudgeContractError("outcome.observedFacts", "classified outcomes require directly observed support");
  }
  return {
    reasons,
    evidenceRefs,
    observedFacts,
    hypotheses: hypotheses(input.hypotheses, "outcome.hypotheses", permitted, outcomeRefs),
    providerMetadata: metadata(input.providerMetadata, "outcome.providerMetadata"),
  };
}

export function normalizeProviderOutcome(value: unknown, request: JudgeRequest): JudgeOutcome {
  const baseline = normalizeJudgeRequest(request);
  const input = record(sanitizeUntrusted(value, "outcome", OUTCOME_DATA_BUDGET), "outcome");
  if (input.status === "classified") {
    if (baseline.evidence.length === 0) {
      throw new JudgeContractError("outcome.status", "cannot classify without current-request evidence");
    }
    exactKeys(
      input,
      ["status", "label", "confidence", "reasons", "evidenceRefs", "observedFacts", "hypotheses", "providerMetadata"],
      "outcome",
    );
    if (typeof input.label !== "string" || !baseline.allowedLabels.includes(input.label)) {
      throw new JudgeContractError("outcome.label", "is not one of request.allowedLabels");
    }
    if (typeof input.confidence !== "number" || !Number.isFinite(input.confidence)
      || input.confidence < 0 || input.confidence > 1) {
      throw new JudgeContractError("outcome.confidence", "must be a finite number from 0 through 1");
    }
    return { status: "classified", label: input.label, confidence: input.confidence, ...support(input, baseline, true) };
  }
  if (input.status === "insufficient") {
    exactKeys(
      input,
      ["status", "reason", "reasons", "evidenceRefs", "observedFacts", "hypotheses", "providerMetadata"],
      "outcome",
    );
    return {
      status: "insufficient",
      reason: text(input.reason, "outcome.reason", 2_000),
      ...support(input, baseline, false),
    };
  }
  if (input.status === "providerFailure") {
    exactKeys(input, ["status", "failure", "providerMetadata"], "outcome");
    const failure = record(input.failure, "outcome.failure");
    exactKeys(failure, ["kind", "message", "retryable"], "outcome.failure");
    const kinds = new Set(["aborted", "deadlineExceeded", "authentication", "rateLimited", "server", "invalidResponse", "provider"]);
    if (typeof failure.kind !== "string" || !kinds.has(failure.kind)) {
      throw new JudgeContractError("outcome.failure.kind", "is unknown");
    }
    if (typeof failure.retryable !== "boolean") {
      throw new JudgeContractError("outcome.failure.retryable", "must be boolean");
    }
    text(failure.message, "outcome.failure.message", 2_000);
    const result: Extract<JudgeOutcome, { status: "providerFailure" }> = {
      status: "providerFailure",
      failure: {
        kind: failure.kind as Extract<JudgeOutcome, { status: "providerFailure" }>["failure"]["kind"],
        message: controlledFailureMessage(failure.kind),
        retryable: failure.retryable,
      },
      ...(input.providerMetadata === undefined
        ? {}
        : { providerMetadata: metadata(input.providerMetadata, "outcome.providerMetadata") }),
    };
    return result;
  }
  throw new JudgeContractError("outcome.status", "must be classified, insufficient, or providerFailure");
}
