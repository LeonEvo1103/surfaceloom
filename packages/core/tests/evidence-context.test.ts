import assert from "node:assert/strict";
import test from "node:test";

import {
  defineEvidenceContext,
  evidenceContextSchemaVersion,
  evidenceRefKey,
} from "../src/evidence-context.js";

const source = Object.freeze({
  kind: "runner" as const,
  producerId: "runner.local",
  sourceRecordId: "record-1",
});

function contextInput() {
  return {
    schemaVersion: evidenceContextSchemaVersion,
    caseExecutionId: "case-exec-1",
    nodes: [
      { kind: "caseExecution", caseExecutionId: "case-exec-1", source },
      { kind: "attempt", caseExecutionId: "case-exec-1", attemptId: "attempt-1", source },
      { kind: "step", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        stepId: "step-1", observedAt: "2026-09-17T01:00:02.000Z", source },
      { kind: "agentRun", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        runId: "run-1", observedAt: "2026-09-17T01:00:01.000Z", source },
      { kind: "toolCall", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        runId: "run-1", callId: "call-1", source },
      { kind: "artifact", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        artifactId: "artifact-1", source },
    ],
    relations: [
      { id: "edge-case-attempt", relation: "contains", source,
        from: { kind: "caseExecution", caseExecutionId: "case-exec-1" },
        to: { kind: "attempt", caseExecutionId: "case-exec-1", attemptId: "attempt-1" } },
      { id: "edge-attempt-step", relation: "contains", source,
        from: { kind: "attempt", caseExecutionId: "case-exec-1", attemptId: "attempt-1" },
        to: { kind: "step", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
          stepId: "step-1" } },
      { id: "edge-step-run", relation: "declaredCause", source,
        from: { kind: "step", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
          stepId: "step-1" },
        to: { kind: "agentRun", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
          runId: "run-1" } },
      { id: "edge-run-call", relation: "contains", source,
        from: { kind: "agentRun", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
          runId: "run-1" },
        to: { kind: "toolCall", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
          runId: "run-1", callId: "call-1" } },
      { id: "edge-call-artifact", relation: "produced", source,
        from: { kind: "toolCall", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
          runId: "run-1", callId: "call-1" },
        to: { kind: "artifact", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
          artifactId: "artifact-1" } },
    ],
  };
}

test("defines a deeply immutable graph with explicit identities and provenance", () => {
  const input = contextInput();
  const result = defineEvidenceContext(input);
  input.nodes[2]!.stepId = "mutated-after-snapshot";

  assert.equal(result.nodes[2]!.kind, "step");
  assert.equal(result.nodes[2]!.kind === "step" ? result.nodes[2].stepId : "", "step-1");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.nodes));
  assert.ok(Object.isFrozen(result.nodes[0]));
  assert.ok(Object.isFrozen(result.nodes[0]!.source));
  assert.ok(Object.isFrozen(result.relations[0]!.from));
  assert.equal(evidenceRefKey(result.nodes[4]!),
    '["toolCall","case-exec-1","attempt-1","run-1","call-1"]');
});

test("timestamps remain diagnostic and never create an undeclared edge", () => {
  const input = contextInput();
  input.relations = input.relations.filter((edge) => edge.id !== "edge-step-run");
  const result = defineEvidenceContext(input);

  assert.equal(result.nodes[2]!.observedAt, "2026-09-17T01:00:02.000Z");
  assert.equal(result.nodes[3]!.observedAt, "2026-09-17T01:00:01.000Z");
  assert.equal(result.relations.some((edge) => edge.relation === "declaredCause"), false);
});

test("rejects unknown fields without invoking getters", () => {
  let reads = 0;
  const input = contextInput();
  Object.defineProperty(input.nodes[0], "caseExecutionId", {
    enumerable: true,
    get() { reads += 1; return "case-exec-1"; },
  });
  assert.throws(() => defineEvidenceContext(input), /data field/u);
  assert.equal(reads, 0);

  assert.throws(() => defineEvidenceContext({ ...contextInput(), unexpected: true }), /unknown field/u);
});

test("snapshots proxy data without consulting property get traps", () => {
  let reads = 0;
  const proxy = new Proxy(contextInput(), {
    get(target, property, receiver) {
      reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const result = defineEvidenceContext(proxy);
  assert.equal(result.caseExecutionId, "case-exec-1");
  assert.equal(reads, 0);
});

test("rejects duplicate and conflicting identities", () => {
  const duplicateNode = contextInput();
  duplicateNode.nodes.push({ ...duplicateNode.nodes[1]! });
  assert.throws(() => defineEvidenceContext(duplicateNode), /Duplicate evidence node/u);

  const duplicateId = contextInput();
  duplicateId.relations[1]!.id = duplicateId.relations[0]!.id;
  assert.throws(() => defineEvidenceContext(duplicateId), /Duplicate evidence relation id/u);

  const duplicateEdge = contextInput();
  duplicateEdge.relations.push({ ...duplicateEdge.relations[0]!, id: "another-id" });
  assert.throws(() => defineEvidenceContext(duplicateEdge), /Duplicate evidence relation:/u);
});

test("rejects missing parents and unknown relation endpoints", () => {
  const missingRun = contextInput();
  missingRun.nodes = missingRun.nodes.filter((item) => item.kind !== "agentRun");
  assert.throws(() => defineEvidenceContext(missingRun), /agent-run parent/u);

  const unknown = contextInput();
  unknown.relations[0]!.to = {
    kind: "attempt", caseExecutionId: "case-exec-1", attemptId: "attempt-missing",
  };
  assert.throws(() => defineEvidenceContext(unknown), /unknown node/u);
});

test("rejects cross-case nodes, cross-attempt edges and cycles", () => {
  const crossCase = contextInput();
  crossCase.nodes[1]!.caseExecutionId = "case-exec-2";
  assert.throws(() => defineEvidenceContext(crossCase), /cross-case node/u);

  const crossAttempt = contextInput();
  crossAttempt.nodes.push({ kind: "attempt", caseExecutionId: "case-exec-1",
    attemptId: "attempt-2", source });
  crossAttempt.nodes.push({ kind: "artifact", caseExecutionId: "case-exec-1",
    attemptId: "attempt-2", artifactId: "artifact-2", source });
  crossAttempt.relations.push({
    id: "cross-attempt", relation: "attachedTo", source,
    from: { kind: "artifact", caseExecutionId: "case-exec-1", attemptId: "attempt-2",
      artifactId: "artifact-2" },
    to: { kind: "step", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
      stepId: "step-1" },
  });
  assert.throws(() => defineEvidenceContext(crossAttempt), /crosses attempts/u);

  const cycle = contextInput();
  cycle.relations.push({
    id: "cycle", relation: "declaredCause", source,
    from: { kind: "toolCall", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
      runId: "run-1", callId: "call-1" },
    to: { kind: "step", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
      stepId: "step-1" },
  });
  assert.throws(() => defineEvidenceContext(cycle), /cycle/u);
});

test("enforces the relation endpoint matrix", () => {
  const invalidEdges = [
    {
      id: "reverse-contains", relation: "contains", source,
      from: { kind: "step", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        stepId: "step-1" },
      to: { kind: "attempt", caseExecutionId: "case-exec-1", attemptId: "attempt-1" },
    },
    {
      id: "reverse-produced", relation: "produced", source,
      from: { kind: "artifact", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        artifactId: "artifact-1" },
      to: { kind: "toolCall", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        runId: "run-1", callId: "call-1" },
    },
    {
      id: "wrong-attachment", relation: "attachedTo", source,
      from: { kind: "step", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        stepId: "step-1" },
      to: { kind: "artifact", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        artifactId: "artifact-1" },
    },
    {
      id: "root-causal", relation: "declaredCause", source,
      from: { kind: "caseExecution", caseExecutionId: "case-exec-1" },
      to: { kind: "step", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        stepId: "step-1" },
    },
    {
      id: "root-observer", relation: "observedBy", source,
      from: { kind: "caseExecution", caseExecutionId: "case-exec-1" },
      to: { kind: "artifact", caseExecutionId: "case-exec-1", attemptId: "attempt-1",
        artifactId: "artifact-1" },
    },
  ];
  for (const edge of invalidEdges) {
    const input = contextInput();
    input.relations = [edge];
    assert.throws(() => defineEvidenceContext(input), /invalid endpoints/u, edge.id);
  }
});

test("checks a near-limit chain and cycle without recursive stack growth", () => {
  const artifactCount = 9_998;
  const artifacts = Array.from({ length: artifactCount }, (_, index) => ({
    kind: "artifact",
    caseExecutionId: "case-exec-large",
    attemptId: "attempt-large",
    artifactId: `artifact-${index}`,
    source,
  }));
  const artifactRef = (index: number) => ({
    kind: "artifact",
    caseExecutionId: "case-exec-large",
    attemptId: "attempt-large",
    artifactId: `artifact-${index}`,
  });
  const nodes = [
    { kind: "caseExecution", caseExecutionId: "case-exec-large", source },
    { kind: "attempt", caseExecutionId: "case-exec-large", attemptId: "attempt-large", source },
    ...artifacts,
  ];
  const relations = [
    { id: "large-case-attempt", relation: "contains", source,
      from: { kind: "caseExecution", caseExecutionId: "case-exec-large" },
      to: { kind: "attempt", caseExecutionId: "case-exec-large", attemptId: "attempt-large" } },
    { id: "large-attempt-first", relation: "contains", source,
      from: { kind: "attempt", caseExecutionId: "case-exec-large", attemptId: "attempt-large" },
      to: artifactRef(0) },
    ...Array.from({ length: artifactCount - 1 }, (_, index) => ({
      id: `large-edge-${index}`,
      relation: "declaredCause",
      source,
      from: artifactRef(index),
      to: artifactRef(index + 1),
    })),
  ];
  const base = {
    schemaVersion: evidenceContextSchemaVersion,
    caseExecutionId: "case-exec-large",
    nodes,
    relations,
  };
  assert.equal(defineEvidenceContext(base).relations.length, 9_999);
  assert.throws(
    () => defineEvidenceContext({ ...base, relations: [...relations, {
      id: "large-cycle",
      relation: "declaredCause",
      source,
      from: artifactRef(artifactCount - 1),
      to: artifactRef(0),
    }] }),
    (error: unknown) => error instanceof Error
      && !(error instanceof RangeError) && /cycle/u.test(error.message),
  );
});

test("enforces one shared snapshot budget across nested branches", () => {
  const padding = Array.from({ length: 51 }, () => Array<null>(10_000).fill(null));
  assert.throws(() => defineEvidenceContext({ ...contextInput(), padding }), /data budget/u);
});
