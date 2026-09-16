import type {
  EvidenceContext,
  EvidenceRef,
  EvidenceSource,
} from "@surfaceloom/core";

export const agentLoopCorrelationSchemaVersion =
  "surfaceloom.agent-loop-correlation/v1" as const;

/** An event-to-evidence association supplied by an identified producer. */
export interface AgentLoopEvidenceBindingInput {
  readonly traceId: string;
  readonly eventId: string;
  readonly evidence: EvidenceRef;
  readonly source: EvidenceSource;
}

export interface AgentLoopCorrelationInput {
  readonly evidenceContext: EvidenceContext;
  readonly traces: readonly import("../model.js").AgentLoopTrace[];
  readonly bindings: readonly AgentLoopEvidenceBindingInput[];
}

export interface CorrelatedAgentLoopEvent {
  readonly traceId: string;
  readonly eventId: string;
  /** Diagnostic ordering metadata copied from the trace; never a causal edge. */
  readonly offsetMs: number;
  readonly evidence: EvidenceRef;
  readonly source: EvidenceSource;
}

/**
 * Additive evidence only. This contract deliberately has no verdict/status field;
 * Reporter and execution-kernel results remain authoritative.
 */
export interface AgentLoopCorrelationEvidence {
  readonly schemaVersion: typeof agentLoopCorrelationSchemaVersion;
  readonly caseExecutionId: string;
  readonly context: EvidenceContext;
  readonly events: readonly CorrelatedAgentLoopEvent[];
}
