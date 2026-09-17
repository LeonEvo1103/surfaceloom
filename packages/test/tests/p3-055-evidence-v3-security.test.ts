import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EvidenceSubmissionCollector,
  RunnerExecutionAuthority,
  SurfaceAcquisitionRegistry,
  type EvidenceSubmission,
  type ExecutionScope,
} from "../src/evidence/index.js";
import { materializeEvidenceV3 } from "../src/report/v3/materialize.js";

const capturedAt = "2026-09-17T01:02:03.000Z";

test("collector rejects scope, identity, graph, shape and timing violations", () => {
  const authority = new RunnerExecutionAuthority({ reportRunId: "run-1", runnerHostId: "runner-1" });
  const scope = authority.issue({ caseExecutionId: "execution-1", attemptId: "attempt-1", ordinal: 1 });
  const otherAttempt = authority.issue({ caseExecutionId: "execution-1", attemptId: "attempt-2", ordinal: 2 });
  const other = authority.issue({ caseExecutionId: "execution-2", attemptId: "attempt-1", ordinal: 1 });
  assert.throws(() => new SurfaceAcquisitionRegistry(scope).authorizeProvider("provider")
    .submit(surface(other)), /crosses execution scopes/);

  const duplicate = new EvidenceSubmissionCollector(scope);
  duplicate.submit(submission(scope, "one", "artifact-1"));
  assert.throws(() => duplicate.submit(submission(scope, "one", "artifact-2")), /Duplicate.*submission/);
  assert.throws(() => duplicate.submit(submission(scope, "two", "artifact-1")), /Duplicate evidence node/);

  const crossed = submission(other, "crossed", "artifact-x");
  assert.throws(() => new EvidenceSubmissionCollector(scope).submit(crossed), /crosses execution scopes/);
  assert.throws(() => new EvidenceSubmissionCollector(scope).submit(
    submission(otherAttempt, "cross-attempt", "artifact-attempt")), /crosses execution scopes/);
  const missingRef = submission(scope, "missing-ref", "artifact-x");
  missingRef.relations[0] = { ...missingRef.relations[0]!, to: {
    kind: "artifact", caseExecutionId: scope.caseExecutionId, attemptId: scope.attemptId,
    artifactId: "not-declared",
  } };
  assert.throws(() => new EvidenceSubmissionCollector(scope).submit(missingRef), /not linked|unknown node/);

  const cyclic = submission(scope, "cyclic", "artifact-a");
  const source = cyclic.source;
  const second = { kind: "artifact" as const, caseExecutionId: scope.caseExecutionId,
    attemptId: scope.attemptId, artifactId: "artifact-b", source };
  cyclic.nodes.push(second);
  const secondRef = { kind: "artifact" as const, caseExecutionId: scope.caseExecutionId,
    attemptId: scope.attemptId, artifactId: "artifact-b" };
  cyclic.relations.push(
    { id: "cause-a-b", relation: "declaredCause", from: cyclic.artifact, to: secondRef, source },
    { id: "cause-b-a", relation: "declaredCause", from: secondRef, to: cyclic.artifact, source },
  );
  assert.throws(() => new EvidenceSubmissionCollector(scope).submit(cyclic), /cycle/);

  const parentBase = submission(scope, "missing-parent", "artifact-parent");
  const missingParent: EvidenceSubmission = { ...parentBase, nodes: [...parentBase.nodes, {
    kind: "toolCall", caseExecutionId: scope.caseExecutionId, attemptId: scope.attemptId,
    runId: "unrecorded-run", callId: "call-1", source: parentBase.source,
  }] };
  assert.throws(() => new EvidenceSubmissionCollector(scope).submit(missingParent), /missing.*parent/);

  const unknown = submission(scope, "unknown", "artifact-u") as EvidenceSubmission & { extra?: string };
  unknown.extra = "not allowed";
  assert.throws(() => new EvidenceSubmissionCollector(scope).submit(unknown), /unknown metadata/);
  const sealed = new EvidenceSubmissionCollector(scope);
  sealed.seal({ capturedAt });
  assert.throws(() => sealed.submit(submission(scope, "late", "artifact-late")), /Late evidence/);
});

test("timestamps, insertion order and correlation ids never synthesize causal edges", () => {
  const scope = oneScope();
  const collector = new EvidenceSubmissionCollector(scope);
  const second = submission(scope, "second", "artifact-second");
  (second as EvidenceSubmission & { correlationId?: string }).correlationId = "same-group";
  collector.submit(second);
  const first = submission(scope, "first", "artifact-first");
  (first as EvidenceSubmission & { correlationId?: string }).correlationId = "same-group";
  collector.submit(first);
  const snapshot = collector.seal({ capturedAt });
  assert.equal(snapshot.context.relations.filter((edge) => edge.relation === "declaredCause").length, 0);
  assert.deepEqual(snapshot.artifacts.map((item) => item.submissionId), ["second", "first"]);
});

test("content gate rejects malformed and oversized data while redacting credentials and paths", () => {
  const scope = oneScope();
  const malformed = submission(scope, "bad-json", "artifact-json");
  malformed.content = { kind: "trace", schemaVersion: "trace/v1", trace: { missing: undefined } };
  assert.throws(() => new EvidenceSubmissionCollector(scope).submit(malformed), /valid JSON/);

  const unknown = submission(scope, "bad-shape", "artifact-shape");
  unknown.content = { kind: "probe", probeId: "probe-1", resource: "db.read",
    outcome: "observed", metadata: "unknown" };
  assert.throws(() => new EvidenceSubmissionCollector(scope).submit(unknown), /unknown metadata/);

  const oversized = submission(scope, "large", "artifact-large");
  oversized.content = { kind: "trace", schemaVersion: "trace/v1", trace: "x".repeat(200) };
  assert.throws(() => new EvidenceSubmissionCollector(scope, { maxArtifactBytes: 64 }).submit(oversized),
    /byte budget/);

  const safe = submission(scope, "safe", "artifact-safe");
  safe.content = { kind: "trace", schemaVersion: "trace/v1", trace: {
    apiToken: "sk-live-should-not-survive", location: "/Users/alice/private/file.txt",
  } };
  const item = new EvidenceSubmissionCollector(scope).submit(safe);
  const serialized = JSON.stringify(item.content);
  assert.doesNotMatch(serialized, /should-not-survive|\/Users\/alice/);
  assert.match(serialized, /REDACTED|USER_HOME/);

  const expands = submission(scope, "expands", "artifact-expands");
  expands.content = { kind: "trace", schemaVersion: "trace/v1", trace: { apiToken: "x" } };
  const rawBytes = Buffer.byteLength(JSON.stringify(expands.content), "utf8");
  assert.throws(() => new EvidenceSubmissionCollector(scope, {
    maxArtifactBytes: rawBytes,
  }).submit(expands), /Normalized evidence content exceeds/);
});

test("submission validation never invokes getters, Proxy traps, or toJSON", () => {
  const scope = oneScope("hostile");
  let getterCalls = 0;
  const getter = submission(scope, "getter", "artifact-getter");
  Object.defineProperty(getter, "content", { enumerable: true, get: () => {
    getterCalls += 1;
    return { kind: "trace", schemaVersion: "trace/v1", trace: null };
  } });
  assert.throws(() => new EvidenceSubmissionCollector(scope).submit(getter), /JSON data field/);
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const proxied = new Proxy(submission(scope, "proxy", "artifact-proxy"), {
    ownKeys: (target) => { proxyTraps += 1; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor: (target, key) => {
      proxyTraps += 1; return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.throws(() => new EvidenceSubmissionCollector(scope).submit(proxied), /Proxy/);
  assert.equal(proxyTraps, 0);

  let toJSONCalls = 0;
  const custom = submission(scope, "to-json", "artifact-to-json");
  custom.content = { kind: "trace", schemaVersion: "trace/v1", trace: {
    toJSON: () => { toJSONCalls += 1; return "unsafe"; },
  } };
  assert.throws(() => new EvidenceSubmissionCollector(scope).submit(custom), /valid JSON data/);
  assert.equal(toJSONCalls, 0);
});

test("materialized evidence never persists credential or absolute-path plaintext", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "p3-055-redaction-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const scope = oneScope("redaction-disk");
  const input = submission(scope, "redacted", "artifact-redacted");
  input.content = { kind: "trace", schemaVersion: "trace/v1", trace: {
    apiToken: "sk-synthetic-never-write-this",
    location: "/Users/synthetic/private/file.txt",
  } };
  const collector = new EvidenceSubmissionCollector(scope);
  collector.submit(input);
  const materialized = await materializeEvidenceV3(collector.seal({ capturedAt }), root);
  const persisted = await readFile(materialized.artifacts[0]!.sourcePath!, "utf8");
  assert.doesNotMatch(persisted, /sk-synthetic-never-write-this|\/Users\/synthetic/);
  assert.match(persisted, /REDACTED|USER_HOME/);
});

test("bounded journals without a trustworthy seal and sequence stay incomplete", () => {
  const cases = [
    { entries: [entry(2)], seal: { lastSequence: 2 } },
    { entries: [], seal: { lastSequence: 1 } },
    { entries: [entry(1), entry(1)], seal: { lastSequence: 1 } },
    { entries: [entry(2), entry(1)], seal: { lastSequence: 1 } },
    { entries: [entry(1)] },
  ];
  for (const [index, journal] of cases.entries()) {
    const scope = oneScope(`execution-${index}`);
    const input = submission(scope, `journal-${index}`, `artifact-${index}`);
    input.content = { kind: "nativeJournal", bounded: true, ...journal };
    const item = new EvidenceSubmissionCollector(scope).submit(input);
    assert.equal(item.completeness.state, "incomplete");
    if (item.completeness.state === "incomplete") {
      assert.ok(item.completeness.reasons.some((reason) => reason.startsWith("journal")));
    }
  }
});

function oneScope(caseExecutionId = "execution-1"): ExecutionScope {
  return new RunnerExecutionAuthority({ reportRunId: "run-1", runnerHostId: "runner-1" })
    .issue({ caseExecutionId, attemptId: "attempt-1", ordinal: 1 });
}

function submission(scope: ExecutionScope, id: string, artifactId: string): EvidenceSubmission & {
  nodes: { kind: "artifact"; caseExecutionId: string; attemptId: string; artifactId: string;
    source: EvidenceSubmission["source"] }[];
  relations: EvidenceSubmission["relations"][number][];
  content: unknown;
} {
  const source = { kind: "probe" as const, producerId: "probe-1", sourceRecordId: id };
  const artifact = { kind: "artifact" as const, caseExecutionId: scope.caseExecutionId,
    attemptId: scope.attemptId, artifactId };
  return { id, scope, source, artifact, nodes: [{ ...artifact, source }],
    relations: [{ id: `link-${id}`, relation: "contains", from: {
      kind: "attempt", caseExecutionId: scope.caseExecutionId, attemptId: scope.attemptId,
    }, to: artifact, source }], completeness: { state: "complete" }, capturedAt,
    content: { kind: "probe", probeId: id, resource: "fixture.read", outcome: "observed" } };
}

function surface(scope: ExecutionScope) {
  return { scope, surfaceId: "page", kind: "browser" as const, hostId: "host-1",
    executionPlatform: "web" as const, effectiveCapabilities: [], ownership: "borrowed" as const,
    cleanup: { status: "notRequired" as const, resource: "page" } };
}

function entry(sequence: number) {
  return { sequence, runId: "run-agent", callId: "call-1", operationId: "operation-1",
    hostInstanceId: "host-instance", sessionId: "session-1", targetIdentity: "target-1",
    resource: "native.ui.invoke", outcome: "succeeded" as const };
}
