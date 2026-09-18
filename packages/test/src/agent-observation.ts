import type {
  AssertionClock, CompletenessRequirement, ObservationAssertionResult,
} from "./assertion-contracts.js";
import { assertObservation } from "./assertion.js";
import { assertIdentifier } from "./definition.js";
import type { Observation, ObservationReadContext } from "./observation.js";

export type AgentRunScope = Readonly<{ runId: string }>;
export type AgentCallScope = Readonly<{ runId: string; callId: string }>;

/** Exact declared resource identity. Prefixes, globs, and inferred resources are not scopes. */
export type AgentResourceScope = Readonly<{ runId: string; resource: string }>;

export type AgentRunStateObservation = Readonly<{ runId: string; state: string }>;
export type AgentApprovalObservation = Readonly<{
  runId: string;
  callId: string;
  requested: boolean;
}>;
export type AgentToolCallObservation = Readonly<{
  runId: string;
  callId: string;
  requested: number;
  started: number;
  completed: number;
}>;
export type AgentExternalEffectObservation = Readonly<{
  runId: string;
  resource: string;
  boundary: "external";
  count: number;
}>;

type MaybePromise<T> = T | Promise<T>;

/**
 * Product adapters implement these authoritative reads. Every invocation must reread its
 * source. Truncated or identity-ambiguous data must be returned as `unknown`; transport
 * failures must be thrown or returned as `read-failed`. A run state is not proof that a
 * ledger or resource interval is complete.
 */
export interface AgentObservationProvider {
  readRunState(scope: AgentRunScope, context: ObservationReadContext):
    MaybePromise<Observation<AgentRunStateObservation>>;
  readApproval(scope: AgentCallScope, context: ObservationReadContext):
    MaybePromise<Observation<AgentApprovalObservation>>;
  readToolCall(scope: AgentCallScope, context: ObservationReadContext):
    MaybePromise<Observation<AgentToolCallObservation>>;
  readExternalEffects(scope: AgentResourceScope, context: ObservationReadContext):
    MaybePromise<Observation<AgentExternalEffectObservation>>;
}

export interface AgentAssertionOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly clock?: AssertionClock;
  readonly criterionId?: string;
  readonly evidenceIds?: readonly string[];
}

export interface AgentCompletionAssertionOptions extends AgentAssertionOptions {
  /** Upper-bound and negative claims require a named barrier; intervals are not accepted. */
  readonly completeness: Extract<CompletenessRequirement, { readonly kind: "barrier" }>;
}

export type NoExternalEffectAssertionOptions = AgentCompletionAssertionOptions;

export function assertAgentRunState(provider: AgentObservationProvider, scope: AgentRunScope,
  expectedState: string, options: AgentAssertionOptions):
  Promise<ObservationAssertionResult<AgentRunStateObservation>> {
  const checked = runScope(scope);
  assertIdentifier(expectedState);
  return assertObservation((context) => provider.readRunState(checked, context), {
    ...options,
    expectation: { kind: "value", expected: { ...checked, state: expectedState },
      matches: (value) => value.runId === checked.runId && value.state === expectedState },
  });
}

export function assertAgentApprovalRequested(provider: AgentObservationProvider,
  scope: AgentCallScope, options: AgentAssertionOptions):
  Promise<ObservationAssertionResult<AgentApprovalObservation>> {
  const checked = callScope(scope);
  return assertObservation((context) => provider.readApproval(checked, context), {
    ...options,
    expectation: { kind: "value", expected: { ...checked, requested: true },
      matches: (value) => sameCall(value, checked) && value.requested === true },
  });
}

/** Establishes that the selected lifecycle phase was observed at least once. */
export function assertAgentToolCall(provider: AgentObservationProvider, scope: AgentCallScope,
  phase: "requested" | "started" | "completed", options: AgentAssertionOptions):
  Promise<ObservationAssertionResult<AgentToolCallObservation>> {
  const checked = callScope(scope);
  const checkedPhase = lifecyclePhase(phase);
  return assertObservation((context) => provider.readToolCall(checked, context), {
    ...options,
    expectation: { kind: "value", expected: { ...checked, phase: checkedPhase, countAtLeast: 1 },
      matches: (value) => sameCall(value, checked) && validCounts(value)
        && value[checkedPhase] >= 1 },
  });
}

/** Establishes one requested -> started -> completed lifecycle for the exact call id. */
export function assertAgentToolCallExactlyOnce(provider: AgentObservationProvider,
  scope: AgentCallScope, options: AgentCompletionAssertionOptions):
  Promise<ObservationAssertionResult<AgentToolCallObservation>> {
  const checked = callScope(scope);
  const { completeness: inputCompleteness, ...assertionOptions } = options;
  const completeness = completionBarrier(inputCompleteness);
  return assertObservation((context) => provider.readToolCall(checked, context), {
    ...assertionOptions,
    expectation: { kind: "negative-value", completeness,
      expected: { ...checked, requested: 1, started: 1, completed: 1 },
      matches: (value) => sameCall(value, checked) && validCounts(value)
        && value.requested === 1 && value.started === 1 && value.completed === 1 },
  });
}

/**
 * Proves zero external effects only for one exact declared resource at a completed barrier.
 * The provider's envelope must carry the same complete barrier; unknown, truncated,
 * read-failed, missing, or incomplete snapshots cannot satisfy this assertion.
 */
export function assertAgentResourceHasNoExternalEffect(provider: AgentObservationProvider,
  scope: AgentResourceScope, options: NoExternalEffectAssertionOptions):
  Promise<ObservationAssertionResult<AgentExternalEffectObservation>> {
  const checked = resourceScope(scope);
  const { completeness: inputCompleteness, ...assertionOptions } = options;
  const completeness = completionBarrier(inputCompleteness);
  return assertObservation((context) => provider.readExternalEffects(checked, context), {
    ...assertionOptions,
    expectation: { kind: "negative-value",
      expected: { ...checked, boundary: "external", count: 0 }, completeness,
      matches: (value) => value.runId === checked.runId && value.resource === checked.resource
        && value.boundary === "external" && nonnegativeCount(value.count) && value.count === 0 },
  });
}

function runScope(scope: AgentRunScope): AgentRunScope {
  assertIdentifier(scope.runId);
  return Object.freeze({ runId: scope.runId });
}

function callScope(scope: AgentCallScope): AgentCallScope {
  assertIdentifier(scope.callId);
  return Object.freeze({ ...runScope(scope), callId: scope.callId });
}

function resourceScope(scope: AgentResourceScope): AgentResourceScope {
  assertIdentifier(scope.resource);
  return Object.freeze({ ...runScope(scope), resource: scope.resource });
}

function lifecyclePhase(input: unknown): "requested" | "started" | "completed" {
  if (input !== "requested" && input !== "started" && input !== "completed") {
    throw new Error("Agent tool-call phase must be requested, started, or completed.");
  }
  return input;
}

function completionBarrier(input: unknown): Extract<CompletenessRequirement, { kind: "barrier" }> {
  if (typeof input !== "object" || input === null || Array.isArray(input)
      || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new Error("Agent completion assertions require a named completion barrier.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || (key !== "kind" && key !== "id"))) {
    throw new Error("Agent completion assertions require only a named completion barrier.");
  }
  const kind = dataField(descriptors.kind);
  const id = dataField(descriptors.id);
  if (kind !== "barrier" || typeof id !== "string") {
    throw new Error("Agent completion assertions require a named completion barrier.");
  }
  assertIdentifier(id);
  return Object.freeze({ kind, id });
}

function dataField(descriptor: PropertyDescriptor | undefined): unknown {
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new Error("Agent completion barrier fields must be enumerable data fields.");
  }
  return descriptor.value;
}

function sameCall(value: { readonly runId: string; readonly callId: string }, scope: AgentCallScope): boolean {
  return value.runId === scope.runId && value.callId === scope.callId;
}

function validCounts(value: AgentToolCallObservation): boolean {
  return nonnegativeCount(value.requested) && nonnegativeCount(value.started)
    && nonnegativeCount(value.completed)
    && value.requested >= value.started && value.started >= value.completed;
}

function nonnegativeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
