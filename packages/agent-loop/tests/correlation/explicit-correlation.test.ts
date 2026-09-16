import assert from "node:assert/strict";
import test from "node:test";

import {
  defineEvidenceContext,
  evidenceContextSchemaVersion,
} from "@surfaceloom/core";

import {
  correlateAgentLoopEvidence,
  maximumCorrelationBindings,
  maximumCorrelationEvents,
  maximumCorrelationTraces,
} from "../../src/correlation/correlate.js";
import { snapshotCorrelationData } from "../../src/correlation/data-snapshot.js";
import { agentLoopCorrelationSchemaVersion } from "../../src/correlation/model.js";
import { agentLoopSchemaVersion, type AgentLoopTrace } from "../../src/model.js";

const runnerSource = Object.freeze({
  kind: "runner" as const,
  producerId: "runner.local",
  sourceRecordId: "record-1",
});
const importerSource = Object.freeze({
  kind: "trace-importer" as const,
  producerId: "adapter.codex",
  sourceRecordId: "line-10",
});

function evidenceContext() {
  return defineEvidenceContext({
    schemaVersion: evidenceContextSchemaVersion,
    caseExecutionId: "case-exec-1",
    nodes: [
      { kind: "caseExecution", caseExecutionId: "case-exec-1", source: runnerSource },
      { kind: "attempt", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        source: runnerSource },
      { kind: "step", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        stepId: "step-1", source: runnerSource },
      { kind: "agentRun", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        runId: "run-1", source: importerSource },
      { kind: "toolCall", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        runId: "run-1", callId: "call-1", source: importerSource },
      { kind: "artifact", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        artifactId: "trace-1", source: runnerSource },
    ],
    relations: [
      { id: "case-attempt", relation: "contains", source: runnerSource,
        from: { kind: "caseExecution", caseExecutionId: "case-exec-1" },
        to: { kind: "attempt", caseExecutionId: "case-exec-1", attemptId: "attempt-1" } },
      { id: "step-run", relation: "declaredCause", source: importerSource,
        from: { kind: "step", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
          stepId: "step-1" },
        to: { kind: "agentRun", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
          runId: "run-1" } },
      { id: "run-call", relation: "contains", source: importerSource,
        from: { kind: "agentRun", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
          runId: "run-1" },
        to: { kind: "toolCall", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
          runId: "run-1", callId: "call-1" } },
      { id: "trace-attached", relation: "attachedTo", source: runnerSource,
        from: { kind: "artifact", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
          artifactId: "trace-1" },
        to: { kind: "attempt", caseExecutionId: "case-exec-1", attemptId: "attempt-1" } },
    ],
  });
}

function trace(id = "trace-1"): AgentLoopTrace {
  return {
    schemaVersion: agentLoopSchemaVersion,
    id,
    title: "Agent run",
    source: "openai/codex",
    startedAt: "2026-09-17T01:00:00.000Z",
    durationMs: 30,
    warnings: [],
    events: [
      { id: "run-start", offsetMs: 2, lane: "agent", phase: "start", name: "run",
        status: "running", correlationId: "nearby" },
      { id: "tool-start", offsetMs: 3, lane: "tool", phase: "start", name: "tool",
        status: "running", correlationId: "nearby" },
      { id: "tool-finish", offsetMs: 7, lane: "tool", phase: "finish", name: "tool",
        status: "passed", correlationId: "nearby", durationMs: 4 },
    ],
  };
}

function runRef() {
  return { kind: "agentRun" as const, caseExecutionId: "case-exec-1",
    attemptId: "attempt-1", runId: "run-1" };
}

function callRef() {
  return { kind: "toolCall" as const, caseExecutionId: "case-exec-1",
    attemptId: "attempt-1", runId: "run-1", callId: "call-1" };
}

test("emits immutable additive evidence for explicitly bound events", () => {
  const result = correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(),
    traces: [trace()],
    bindings: [
      { traceId: "trace-1", eventId: "tool-start", evidence: callRef(), source: importerSource },
      { traceId: "trace-1", eventId: "run-start", evidence: runRef(), source: importerSource },
    ],
  });

  assert.equal(result.schemaVersion, agentLoopCorrelationSchemaVersion);
  assert.equal(result.caseExecutionId, "case-exec-1");
  assert.deepEqual(result.events.map((event) => event.eventId), ["run-start", "tool-start"]);
  assert.equal(result.events[1]!.evidence.kind, "toolCall");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.events));
  assert.ok(Object.isFrozen(result.events[0]));
  assert.ok(Object.isFrozen(result.events[0]!.evidence));
  assert.equal("verdict" in result, false);
  assert.equal("status" in result, false);
});

test("does not infer causality from adjacency, offsets or correlationId", () => {
  const result = correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(), traces: [trace()], bindings: [],
  });

  assert.deepEqual(result.events, []);
  assert.equal(result.context.relations.some((edge) => edge.id === "step-run"), true);
  assert.equal(result.context.relations.length, 4);
});

test("trace content cannot rewrite an authoritative verdict", () => {
  const authoritative = Object.freeze({
    caseExecutionId: "case-exec-1", attemptId: "attempt-1", status: "failed" as const,
  });
  const malicious = trace();
  malicious.events[0] = {
    ...malicious.events[0]!,
    status: "passed",
    details: { verdict: "passed", authoritative: true },
  };
  const result = correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(), traces: [malicious],
    bindings: [{ traceId: "trace-1", eventId: "run-start", evidence: runRef(),
      source: importerSource }],
  });

  assert.equal(authoritative.status, "failed");
  assert.equal("verdict" in result, false);
  assert.equal("status" in result, false);
});

test("fails closed for unknown trace events and evidence", () => {
  assert.throws(() => correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(), traces: [trace()],
    bindings: [{ traceId: "missing", eventId: "run-start", evidence: runRef(),
      source: importerSource }],
  }), /unknown trace event/u);

  assert.throws(() => correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(), traces: [trace()],
    bindings: [{ traceId: "trace-1", eventId: "missing", evidence: runRef(),
      source: importerSource }],
  }), /unknown trace event/u);

  assert.throws(() => correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(), traces: [trace()],
    bindings: [{ traceId: "trace-1", eventId: "run-start",
      evidence: { ...runRef(), runId: "unknown" }, source: importerSource }],
  }), /unknown evidence/u);
});

test("fails closed for cross-case and duplicate/conflicting bindings", () => {
  assert.throws(() => correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(), traces: [trace()],
    bindings: [{ traceId: "trace-1", eventId: "run-start",
      evidence: { ...runRef(), caseExecutionId: "case-exec-2" }, source: importerSource }],
  }), /crosses case executions/u);

  assert.throws(() => correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(), traces: [trace()],
    bindings: [
      { traceId: "trace-1", eventId: "run-start", evidence: runRef(), source: importerSource },
      { traceId: "trace-1", eventId: "run-start", evidence: callRef(), source: importerSource },
    ],
  }), /Duplicate or conflicting event binding/u);
});

test("fails closed for duplicate trace ids and unknown binding fields", () => {
  assert.throws(() => correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(), traces: [trace(), trace()], bindings: [],
  }), /Duplicate agent-loop trace id/u);

  assert.throws(() => correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(), traces: [trace()],
    bindings: [{ traceId: "trace-1", eventId: "run-start", evidence: runRef(),
      source: importerSource, inferredFromTime: true }],
  }), /unknown field/u);
});

test("takes one data snapshot and never invokes input getters", () => {
  let reads = 0;
  const binding = {
    traceId: "trace-1",
    eventId: "run-start",
    evidence: runRef(),
    source: importerSource,
  };
  Object.defineProperty(binding, "eventId", {
    enumerable: true,
    get() { reads += 1; return "run-start"; },
  });
  assert.throws(() => correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(), traces: [trace()], bindings: [binding],
  }), /data field/u);
  assert.equal(reads, 0);
});

test("does not consult proxy get traps while taking the correlation snapshot", () => {
  let reads = 0;
  const input = {
    evidenceContext: evidenceContext(),
    traces: [trace()],
    bindings: [{ traceId: "trace-1", eventId: "run-start", evidence: runRef(),
      source: importerSource }],
  };
  const proxy = new Proxy(input, {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.equal(correlateAgentLoopEvidence(proxy).events.length, 1);
  assert.equal(reads, 0);
});

test("rejects aggregate trace, event and binding amplification", () => {
  assert.throws(() => correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(),
    traces: Array.from({ length: maximumCorrelationTraces + 1 }, (_, index) => trace(`t-${index}`)),
    bindings: [],
  }), /maximum trace count/u);

  const repeatedEvent = trace().events[0]!;
  const first = { ...trace("events-a"), events: Array(10_000).fill(repeatedEvent) };
  const second = { ...trace("events-b"), events: Array(10_000).fill(repeatedEvent) };
  const overflow = { ...trace("events-c"), events: Array(
    maximumCorrelationEvents - 20_000 + 1,
  ).fill(repeatedEvent) };
  assert.throws(() => correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(), traces: [first, second, overflow], bindings: [],
  }), /maximum total event count/u);

  assert.throws(() => correlateAgentLoopEvidence({
    evidenceContext: evidenceContext(), traces: [trace()],
    bindings: Array(maximumCorrelationBindings + 1).fill({}),
  }), /maximum binding count/u);
});

test("enforces one global snapshot budget across nested branches", () => {
  assert.throws(() => snapshotCorrelationData(
    { left: { value: 1 }, right: { value: 2 } },
    "agent-loop correlation input",
    { maxDataUnits: 4, maxTraces: 1, maxEvents: 1, maxBindings: 1 },
  ), /data budget/u);
});
