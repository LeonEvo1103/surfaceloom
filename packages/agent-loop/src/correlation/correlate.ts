import {
  defineEvidenceContext,
  defineEvidenceRef,
  defineEvidenceSource,
  evidenceRefKey,
  type EvidenceRef,
} from "@surfaceloom/core";

import { validateAgentLoopTrace } from "../validate.js";
import { snapshotCorrelationData } from "./data-snapshot.js";
import {
  agentLoopCorrelationSchemaVersion,
  type AgentLoopCorrelationEvidence,
  type CorrelatedAgentLoopEvent,
} from "./model.js";

interface RecordValue { readonly [key: string]: unknown; }

export const maximumCorrelationTraces = 128;
export const maximumCorrelationEvents = 20_000;
export const maximumCorrelationBindings = 10_000;
const maximumCorrelationDataUnits = 500_000;

/**
 * Correlates only explicit bindings. Trace order, offsetMs and correlationId are
 * never converted into an evidence relationship.
 */
export function correlateAgentLoopEvidence(input: unknown): AgentLoopCorrelationEvidence {
  const snapshot = record("agent-loop correlation input",
    snapshotCorrelationData(input, "agent-loop correlation input", {
      maxDataUnits: maximumCorrelationDataUnits,
      maxTraces: maximumCorrelationTraces,
      maxEvents: maximumCorrelationEvents,
      maxBindings: maximumCorrelationBindings,
    }));
  exact(snapshot, ["evidenceContext", "traces", "bindings"], "agent-loop correlation input");
  const context = defineEvidenceContext(snapshot.evidenceContext);
  const nodeKeys = new Set(context.nodes.map(evidenceRefKey));

  const traces = array("traces", snapshot.traces);
  if (traces.length > maximumCorrelationTraces) {
    throw new Error("Agent-loop correlation input exceeds the maximum trace count.");
  }
  const events = new Map<string, { readonly offsetMs: number }>();
  const traceIds = new Set<string>();
  let totalEvents = 0;
  for (let index = 0; index < traces.length; index += 1) {
    const trace = traces[index] as import("../model.js").AgentLoopTrace;
    validateAgentLoopTrace(trace);
    totalEvents += trace.events.length;
    if (totalEvents > maximumCorrelationEvents) {
      throw new Error("Agent-loop correlation input exceeds the maximum total event count.");
    }
    if (traceIds.has(trace.id)) throw new Error(`Duplicate agent-loop trace id: ${trace.id}`);
    traceIds.add(trace.id);
    for (const event of trace.events) {
      events.set(eventKey(trace.id, event.id), Object.freeze({ offsetMs: event.offsetMs }));
    }
  }

  const bindings = array("bindings", snapshot.bindings);
  if (bindings.length > maximumCorrelationBindings) {
    throw new Error("Agent-loop correlation input exceeds the maximum binding count.");
  }
  const boundEvents = new Set<string>();
  const result: CorrelatedAgentLoopEvent[] = [];
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = record(`bindings[${index}]`, bindings[index]);
    exact(binding, ["traceId", "eventId", "evidence", "source"], `bindings[${index}]`);
    const traceId = identifier(`bindings[${index}].traceId`, binding.traceId);
    const eventId = identifier(`bindings[${index}].eventId`, binding.eventId);
    const key = eventKey(traceId, eventId);
    const event = events.get(key);
    if (event === undefined) throw new Error(`Binding references an unknown trace event: ${key}`);
    if (boundEvents.has(key)) throw new Error(`Duplicate or conflicting event binding: ${key}`);
    boundEvents.add(key);
    const evidence = defineEvidenceRef(binding.evidence);
    if (evidence.caseExecutionId !== context.caseExecutionId) {
      throw new Error(`Binding ${key} crosses case executions.`);
    }
    if (!nodeKeys.has(evidenceRefKey(evidence))) {
      throw new Error(`Binding ${key} references unknown evidence.`);
    }
    result.push(Object.freeze({
      traceId,
      eventId,
      offsetMs: event.offsetMs,
      evidence,
      source: defineEvidenceSource(binding.source),
    }));
  }

  result.sort((left, right) => compareText(left.traceId, right.traceId)
    || left.offsetMs - right.offsetMs || compareText(left.eventId, right.eventId));
  return Object.freeze({
    schemaVersion: agentLoopCorrelationSchemaVersion,
    caseExecutionId: context.caseExecutionId,
    context,
    events: Object.freeze(result),
  });
}

function eventKey(traceId: string, eventId: string): string {
  return JSON.stringify([traceId, eventId]);
}

function record(label: string, value: unknown): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as RecordValue;
}

function array(label: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function exact(value: RecordValue, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${label} contains an unknown field: ${unknown}.`);
}

function identifier(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)) {
    throw new Error(`${label} must be a stable identifier.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
