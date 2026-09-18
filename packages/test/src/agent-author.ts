import type { AssertionClock, CompletenessRequirement, ObservationAssertionResult } from "./assertion-contracts.js";
import {
  assertAgentApprovalRequested,
  assertAgentResourceHasNoExternalEffect,
  assertAgentRunState,
  assertAgentToolCall,
  assertAgentToolCallExactlyOnce,
  type AgentApprovalObservation,
  type AgentExternalEffectObservation,
  type AgentObservationProvider,
  type AgentRunStateObservation,
  type AgentToolCallObservation,
} from "./agent-observation.js";
import { assertIdentifier } from "./definition.js";

declare const agentAuthorBrand: unique symbol;

export interface AgentAssertionDefaults {
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly clock?: AssertionClock;
}

export interface AgentAuthorAssertionOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly clock?: AssertionClock;
  readonly criterionId?: string;
  readonly evidenceIds?: readonly string[];
}

export interface AgentAuthorCompletionOptions extends AgentAuthorAssertionOptions {
  readonly barrier: Extract<CompletenessRequirement, { readonly kind: "barrier" }>;
}

export interface AgentToolBinding {
  /** Product adapter's stable semantic tool id, not a display label. */
  readonly toolId: string;
  /** Exact call identity whose lifecycle will be asserted. */
  readonly callId: string;
}

export interface AgentRunBinding {
  readonly provider: AgentObservationProvider;
  readonly runId: string;
  /** Exact call identity which owns this run's approval request. */
  readonly approvalCallId: string;
  readonly tools: readonly AgentToolBinding[];
  readonly assertion: AgentAssertionDefaults;
}

export interface AgentRun {
  readonly [agentAuthorBrand]: "run";
  readonly runId: string;
  tool(toolId: string): AgentTool;
  resource(resource: string): AgentResource;
}

export interface AgentTool {
  readonly [agentAuthorBrand]: "tool";
  readonly runId: string;
  readonly toolId: string;
  readonly callId: string;
}

export interface AgentResource {
  readonly [agentAuthorBrand]: "resource";
  readonly runId: string;
  readonly resource: string;
}

export interface AgentRunExpectation {
  toHaveRunState(expectedState: string, options?: AgentAuthorAssertionOptions):
    Promise<ObservationAssertionResult<AgentRunStateObservation>>;
  toHaveRequestedApproval(options?: AgentAuthorAssertionOptions):
    Promise<ObservationAssertionResult<AgentApprovalObservation>>;
}

export interface AgentToolExpectation {
  toHaveLifecyclePhase(phase: "requested" | "started" | "completed",
    options?: AgentAuthorAssertionOptions): Promise<ObservationAssertionResult<AgentToolCallObservation>>;
  /** Proves only this exact call lifecycle; it does not prove one logical business effect. */
  toHaveExecutedExactlyOnce(options: AgentAuthorCompletionOptions):
    Promise<ObservationAssertionResult<AgentToolCallObservation>>;
}

export interface AgentResourceExpectation {
  /** Valid only for a provider observation declaring boundary: "external". */
  toHaveNoExternalEffect(options: AgentAuthorCompletionOptions):
    Promise<ObservationAssertionResult<AgentExternalEffectObservation>>;
}

interface BoundRun {
  readonly provider: AgentObservationProvider;
  readonly runId: string;
  readonly approvalCallId: string;
  readonly tools: ReadonlyMap<string, string>;
  readonly assertion: AgentAssertionDefaults;
}

const runs = new WeakMap<AgentRun, BoundRun>();
const tools = new WeakMap<AgentTool, BoundRun>();
const resources = new WeakMap<AgentResource, BoundRun>();

/** Product adapters bind authoritative identities; Case authors receive only this facade. */
export function bindAgentRun(input: AgentRunBinding): AgentRun {
  const runId = identifier(input.runId);
  const approvalCallId = identifier(input.approvalCallId);
  assertProvider(input.provider);
  const mappedTools = new Map<string, string>();
  const mappedCalls = new Set<string>();
  if (!Array.isArray(input.tools)) throw new Error("Agent tool bindings must be an array.");
  for (const item of input.tools) {
    const toolId = identifier(item.toolId);
    const callId = identifier(item.callId);
    if (mappedTools.has(toolId)) throw new Error(`Duplicate Agent tool binding: ${toolId}.`);
    if (mappedCalls.has(callId)) throw new Error(`Duplicate Agent call binding: ${callId}.`);
    mappedTools.set(toolId, callId);
    mappedCalls.add(callId);
  }
  const assertion = Object.freeze({ ...input.assertion });
  const bound = Object.freeze({ provider: input.provider, runId, approvalCallId,
    tools: mappedTools, assertion });
  const author: AgentRun = Object.freeze({ runId,
    tool: (toolId: string) => bindTool(bound, toolId),
    resource: (resource: string) => bindResource(bound, resource),
  }) as AgentRun;
  runs.set(author, bound);
  return author;
}

export function expectAgent(target: AgentRun): AgentRunExpectation;
export function expectAgent(target: AgentTool): AgentToolExpectation;
export function expectAgent(target: AgentResource): AgentResourceExpectation;
export function expectAgent(target: AgentRun | AgentTool | AgentResource):
AgentRunExpectation | AgentToolExpectation | AgentResourceExpectation {
  const run = runs.get(target as AgentRun);
  if (run !== undefined) return runExpectation(run);
  const tool = tools.get(target as AgentTool);
  if (tool !== undefined) return toolExpectation(tool, target as AgentTool);
  const resource = resources.get(target as AgentResource);
  if (resource !== undefined) return resourceExpectation(resource, target as AgentResource);
  throw new Error("expectAgent() requires an author facade returned by bindAgentRun().");
}

function runExpectation(bound: BoundRun): AgentRunExpectation {
  return Object.freeze({
    toHaveRunState: (state: string, options?: AgentAuthorAssertionOptions) =>
      assertAgentRunState(bound.provider, { runId: bound.runId }, state, merged(bound, options)),
    toHaveRequestedApproval: (options?: AgentAuthorAssertionOptions) =>
      assertAgentApprovalRequested(bound.provider,
        { runId: bound.runId, callId: bound.approvalCallId }, merged(bound, options)),
  });
}

function toolExpectation(bound: BoundRun, tool: AgentTool): AgentToolExpectation {
  const scope = { runId: tool.runId, callId: tool.callId };
  return Object.freeze({
    toHaveLifecyclePhase: (phase: "requested" | "started" | "completed",
      options?: AgentAuthorAssertionOptions) =>
      assertAgentToolCall(bound.provider, scope, phase, merged(bound, options)),
    toHaveExecutedExactlyOnce: ({ barrier, ...options }: AgentAuthorCompletionOptions) =>
      assertAgentToolCallExactlyOnce(bound.provider, scope,
        { ...merged(bound, options), completeness: barrier }),
  });
}

function resourceExpectation(bound: BoundRun, resource: AgentResource): AgentResourceExpectation {
  return Object.freeze({
    toHaveNoExternalEffect: ({ barrier, ...options }: AgentAuthorCompletionOptions) =>
      assertAgentResourceHasNoExternalEffect(bound.provider,
        { runId: resource.runId, resource: resource.resource },
        { ...merged(bound, options), completeness: barrier }),
  });
}

function bindTool(bound: BoundRun, requestedToolId: string): AgentTool {
  const toolId = identifier(requestedToolId);
  const callId = bound.tools.get(toolId);
  if (callId === undefined) throw new Error(`Agent run has no exact call binding for tool '${toolId}'.`);
  const author = Object.freeze({ runId: bound.runId, toolId, callId }) as AgentTool;
  tools.set(author, bound);
  return author;
}

function bindResource(bound: BoundRun, requestedResource: string): AgentResource {
  const resource = identifier(requestedResource);
  const author = Object.freeze({ runId: bound.runId, resource }) as AgentResource;
  resources.set(author, bound);
  return author;
}

function merged(bound: BoundRun, options: AgentAuthorAssertionOptions = {}) {
  return { ...bound.assertion, ...options };
}

function identifier(value: string): string {
  assertIdentifier(value);
  return value;
}

function assertProvider(provider: AgentObservationProvider): void {
  for (const method of ["readRunState", "readApproval", "readToolCall", "readExternalEffects"] as const) {
    if (typeof provider?.[method] !== "function") throw new Error(`Agent provider requires ${method}().`);
  }
}
