export const evidenceContextSchemaVersion = "surfaceloom.evidence-context/v1" as const;

export type EvidenceSourceKind = "runner" | "adapter" | "probe" | "trace-importer";

/** Provenance is mandatory for both facts and declared relationships. */
export interface EvidenceSource {
  readonly kind: EvidenceSourceKind;
  readonly producerId: string;
  readonly sourceRecordId: string;
}

export interface CaseExecutionEvidenceRef {
  readonly kind: "caseExecution";
  readonly caseExecutionId: string;
}

export interface AttemptEvidenceRef {
  readonly kind: "attempt";
  readonly caseExecutionId: string;
  readonly attemptId: string;
}

export interface StepEvidenceRef {
  readonly kind: "step";
  readonly caseExecutionId: string;
  readonly attemptId: string;
  readonly stepId: string;
}

export interface AgentRunEvidenceRef {
  readonly kind: "agentRun";
  readonly caseExecutionId: string;
  readonly attemptId: string;
  readonly runId: string;
}

export interface ToolCallEvidenceRef {
  readonly kind: "toolCall";
  readonly caseExecutionId: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly callId: string;
}

export interface ArtifactEvidenceRef {
  readonly kind: "artifact";
  readonly caseExecutionId: string;
  readonly attemptId: string;
  readonly artifactId: string;
}

export type EvidenceRef =
  | CaseExecutionEvidenceRef
  | AttemptEvidenceRef
  | StepEvidenceRef
  | AgentRunEvidenceRef
  | ToolCallEvidenceRef
  | ArtifactEvidenceRef;

export type EvidenceNode = EvidenceRef & {
  readonly source: EvidenceSource;
  /** Optional source time is diagnostic metadata only. It never creates a relationship. */
  readonly observedAt?: string;
};

export type EvidenceRelationKind =
  | "contains"
  | "declaredCause"
  | "produced"
  | "observedBy"
  | "attachedTo";

/**
 * A relationship exists only because a producer explicitly declared this edge.
 * Array order and observedAt must never be interpreted as causality.
 */
export interface EvidenceRelation {
  readonly id: string;
  readonly relation: EvidenceRelationKind;
  readonly from: EvidenceRef;
  readonly to: EvidenceRef;
  readonly source: EvidenceSource;
}

export interface EvidenceContext {
  readonly schemaVersion: typeof evidenceContextSchemaVersion;
  readonly caseExecutionId: string;
  readonly nodes: readonly EvidenceNode[];
  readonly relations: readonly EvidenceRelation[];
}

const SOURCE_KINDS = new Set<EvidenceSourceKind>([
  "runner", "adapter", "probe", "trace-importer",
]);
const RELATIONS = new Set<EvidenceRelationKind>([
  "contains", "declaredCause", "produced", "observedBy", "attachedTo",
]);
const MAX_ITEMS = 10_000;
const MAX_SNAPSHOT_DATA_UNITS = 500_000;

/**
 * Creates a getter-free, deeply frozen evidence graph and fails closed on
 * ambiguous identities, missing parents, unknown references, cross-case edges,
 * duplicate declarations and cycles.
 */
export function defineEvidenceContext(input: unknown): EvidenceContext {
  const snapshot = snapshotData(input, "evidence context");
  const context = record("evidence context", snapshot);
  exact(context, ["schemaVersion", "caseExecutionId", "nodes", "relations"], "evidence context");
  if (context.schemaVersion !== evidenceContextSchemaVersion) {
    throw new Error("Unsupported evidence-context schema version.");
  }
  const caseExecutionId = identifier("caseExecutionId", context.caseExecutionId);
  const rawNodes = array("evidence context.nodes", context.nodes);
  const rawRelations = array("evidence context.relations", context.relations);
  if (rawNodes.length > MAX_ITEMS || rawRelations.length > MAX_ITEMS) {
    throw new Error("Evidence context exceeds the maximum graph size.");
  }

  const nodes = rawNodes.map((value, index) => node(value, `nodes[${index}]`));
  const nodeByKey = new Map<string, EvidenceNode>();
  for (const item of nodes) {
    if (item.caseExecutionId !== caseExecutionId) {
      throw new Error("Evidence context contains a cross-case node.");
    }
    const key = evidenceRefKey(item);
    if (nodeByKey.has(key)) throw new Error(`Duplicate evidence node: ${key}`);
    nodeByKey.set(key, item);
  }
  const rootKey = evidenceRefKey({ kind: "caseExecution", caseExecutionId });
  if (!nodeByKey.has(rootKey)) throw new Error("Evidence context is missing its case execution node.");
  validateParents(nodes, nodeByKey);

  const relations = rawRelations.map((value, index) =>
    relation(value, `relations[${index}]`));
  const relationIds = new Set<string>();
  const edgeKeys = new Set<string>();
  for (const edge of relations) {
    identifier("relation id", edge.id);
    if (relationIds.has(edge.id)) throw new Error(`Duplicate evidence relation id: ${edge.id}`);
    relationIds.add(edge.id);
    const fromKey = evidenceRefKey(edge.from);
    const toKey = evidenceRefKey(edge.to);
    if (!nodeByKey.has(fromKey) || !nodeByKey.has(toKey)) {
      throw new Error(`Evidence relation ${edge.id} references an unknown node.`);
    }
    if (edge.from.caseExecutionId !== caseExecutionId
        || edge.to.caseExecutionId !== caseExecutionId) {
      throw new Error(`Evidence relation ${edge.id} crosses case executions.`);
    }
    if (!compatibleAttempt(edge.from, edge.to)) {
      throw new Error(`Evidence relation ${edge.id} crosses attempts.`);
    }
    if (!validRelationEndpoints(edge)) {
      throw new Error(`Evidence relation ${edge.id} has invalid endpoints for ${edge.relation}.`);
    }
    const edgeKey = JSON.stringify([edge.relation, fromKey, toKey]);
    if (edgeKeys.has(edgeKey)) throw new Error(`Duplicate evidence relation: ${edge.id}`);
    edgeKeys.add(edgeKey);
  }
  rejectCycles(relations);

  return Object.freeze({
    schemaVersion: evidenceContextSchemaVersion,
    caseExecutionId,
    nodes: Object.freeze(nodes),
    relations: Object.freeze(relations),
  });
}

/** Validates and snapshots one reference using the same identity rules as the graph. */
export function defineEvidenceRef(input: unknown): EvidenceRef {
  return evidenceRef(record("evidence reference", snapshotData(input, "evidence reference")),
    "evidence reference");
}

/** Validates and snapshots provenance for an external evidence binding. */
export function defineEvidenceSource(input: unknown): EvidenceSource {
  return evidenceSource(snapshotData(input, "evidence source"), "evidence source");
}

export function evidenceRefKey(value: EvidenceRef): string {
  switch (value.kind) {
    case "caseExecution": return JSON.stringify([value.kind, value.caseExecutionId]);
    case "attempt": return JSON.stringify([value.kind, value.caseExecutionId, value.attemptId]);
    case "step": return JSON.stringify([value.kind, value.caseExecutionId, value.attemptId, value.stepId]);
    case "agentRun": return JSON.stringify([value.kind, value.caseExecutionId, value.attemptId, value.runId]);
    case "toolCall": return JSON.stringify([
      value.kind, value.caseExecutionId, value.attemptId, value.runId, value.callId,
    ]);
    case "artifact": return JSON.stringify([
      value.kind, value.caseExecutionId, value.attemptId, value.artifactId,
    ]);
  }
}

function node(value: unknown, label: string): EvidenceNode {
  const item = record(label, value);
  const ref = evidenceRef(item, label, ["source", "observedAt"]);
  const allowed = [...refKeys(ref.kind), "source", "observedAt"];
  exact(item, allowed, label);
  const source = evidenceSource(item.source, `${label}.source`);
  const observedAt = item.observedAt === undefined
    ? undefined
    : timestamp(`${label}.observedAt`, item.observedAt);
  return Object.freeze({
    ...ref,
    source,
    ...(observedAt === undefined ? {} : { observedAt }),
  }) as EvidenceNode;
}

function relation(value: unknown, label: string): EvidenceRelation {
  const item = record(label, value);
  exact(item, ["id", "relation", "from", "to", "source"], label);
  const id = identifier(`${label}.id`, item.id);
  if (!RELATIONS.has(item.relation as EvidenceRelationKind)) {
    throw new Error(`${label}.relation is unknown.`);
  }
  return Object.freeze({
    id,
    relation: item.relation as EvidenceRelationKind,
    from: evidenceRef(record(`${label}.from`, item.from), `${label}.from`),
    to: evidenceRef(record(`${label}.to`, item.to), `${label}.to`),
    source: evidenceSource(item.source, `${label}.source`),
  });
}

function evidenceRef(
  item: Record<string, unknown>,
  label: string,
  additionalKeys: readonly string[] = [],
): EvidenceRef {
  const kind = item.kind;
  if (typeof kind !== "string" || ![
    "caseExecution", "attempt", "step", "agentRun", "toolCall", "artifact",
  ].includes(kind)) throw new Error(`${label}.kind is unknown.`);
  exact(item, [...refKeys(kind), ...additionalKeys], label);
  const caseExecutionId = identifier(`${label}.caseExecutionId`, item.caseExecutionId);
  switch (kind) {
    case "caseExecution": return Object.freeze({ kind, caseExecutionId });
    case "attempt": return Object.freeze({
      kind, caseExecutionId, attemptId: identifier(`${label}.attemptId`, item.attemptId),
    });
    case "step": return Object.freeze({
      kind, caseExecutionId,
      attemptId: identifier(`${label}.attemptId`, item.attemptId),
      stepId: identifier(`${label}.stepId`, item.stepId),
    });
    case "agentRun": return Object.freeze({
      kind, caseExecutionId,
      attemptId: identifier(`${label}.attemptId`, item.attemptId),
      runId: identifier(`${label}.runId`, item.runId),
    });
    case "toolCall": return Object.freeze({
      kind, caseExecutionId,
      attemptId: identifier(`${label}.attemptId`, item.attemptId),
      runId: identifier(`${label}.runId`, item.runId),
      callId: identifier(`${label}.callId`, item.callId),
    });
    case "artifact": return Object.freeze({
      kind, caseExecutionId,
      attemptId: identifier(`${label}.attemptId`, item.attemptId),
      artifactId: identifier(`${label}.artifactId`, item.artifactId),
    });
    default: throw new Error(`${label}.kind is unknown.`);
  }
}

function evidenceSource(value: unknown, label: string): EvidenceSource {
  const source = record(label, value);
  exact(source, ["kind", "producerId", "sourceRecordId"], label);
  if (!SOURCE_KINDS.has(source.kind as EvidenceSourceKind)) {
    throw new Error(`${label}.kind is unknown.`);
  }
  return Object.freeze({
    kind: source.kind as EvidenceSourceKind,
    producerId: identifier(`${label}.producerId`, source.producerId),
    sourceRecordId: identifier(`${label}.sourceRecordId`, source.sourceRecordId),
  });
}

function refKeys(kind: string): string[] {
  switch (kind) {
    case "caseExecution": return ["kind", "caseExecutionId"];
    case "attempt": return ["kind", "caseExecutionId", "attemptId"];
    case "step": return ["kind", "caseExecutionId", "attemptId", "stepId"];
    case "agentRun": return ["kind", "caseExecutionId", "attemptId", "runId"];
    case "toolCall": return ["kind", "caseExecutionId", "attemptId", "runId", "callId"];
    case "artifact": return ["kind", "caseExecutionId", "attemptId", "artifactId"];
    default: return ["kind"];
  }
}

function validateParents(nodes: readonly EvidenceNode[], byKey: ReadonlyMap<string, EvidenceNode>): void {
  for (const item of nodes) {
    if (item.kind === "caseExecution") continue;
    const attempt: AttemptEvidenceRef = {
      kind: "attempt", caseExecutionId: item.caseExecutionId, attemptId: item.attemptId,
    };
    if (!byKey.has(evidenceRefKey(attempt))) {
      throw new Error(`Evidence node ${evidenceRefKey(item)} is missing its attempt parent.`);
    }
    if (item.kind === "toolCall") {
      const run: AgentRunEvidenceRef = {
        kind: "agentRun", caseExecutionId: item.caseExecutionId,
        attemptId: item.attemptId, runId: item.runId,
      };
      if (!byKey.has(evidenceRefKey(run))) {
        throw new Error(`Evidence node ${evidenceRefKey(item)} is missing its agent-run parent.`);
      }
    }
  }
}

function compatibleAttempt(left: EvidenceRef, right: EvidenceRef): boolean {
  if (left.kind === "caseExecution" || right.kind === "caseExecution") return true;
  return left.attemptId === right.attemptId;
}

/**
 * Endpoint matrix:
 * - contains: caseExecution→attempt, attempt→step/agentRun/artifact,
 *   agentRun→toolCall;
 * - produced/observedBy: step/agentRun/toolCall→artifact;
 * - attachedTo: artifact→attempt/step/agentRun/toolCall;
 * - declaredCause: step/agentRun/toolCall/artifact→the same non-root set.
 *
 * Case and attempt roots are structural scopes, never causal shortcuts.
 */
function validRelationEndpoints(edge: EvidenceRelation): boolean {
  const from = edge.from.kind;
  const to = edge.to.kind;
  if (edge.relation === "contains") {
    return (from === "caseExecution" && to === "attempt")
      || (from === "attempt" && ["step", "agentRun", "artifact"].includes(to))
      || (from === "agentRun" && to === "toolCall");
  }
  if (edge.relation === "produced" || edge.relation === "observedBy") {
    return ["step", "agentRun", "toolCall"].includes(from) && to === "artifact";
  }
  if (edge.relation === "attachedTo") {
    return from === "artifact" && ["attempt", "step", "agentRun", "toolCall"].includes(to);
  }
  const causalKinds = ["step", "agentRun", "toolCall", "artifact"];
  return causalKinds.includes(from) && causalKinds.includes(to);
}

function rejectCycles(relations: readonly EvidenceRelation[]): void {
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const edge of relations) {
    const from = evidenceRefKey(edge.from);
    const to = evidenceRefKey(edge.to);
    const targets = adjacency.get(from) ?? [];
    targets.push(to);
    adjacency.set(from, targets);
    if (!indegree.has(from)) indegree.set(from, 0);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([key]) => key);
  let visited = 0;
  for (let index = 0; index < ready.length; index += 1) {
    const key = ready[index]!;
    visited += 1;
    for (const target of adjacency.get(key) ?? []) {
      const next = indegree.get(target)! - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (visited !== indegree.size) throw new Error("Evidence relations contain a cycle.");
}

interface SnapshotBudget { remaining: number; }

function snapshotData(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
  depth = 0,
  budget: SnapshotBudget = { remaining: MAX_SNAPSHOT_DATA_UNITS },
): unknown {
  budget.remaining -= 1;
  if (budget.remaining < 0) throw new Error("Evidence context exceeds the maximum data budget.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return value;
  }
  if (typeof value !== "object") throw new Error(`${label} contains a non-data value.`);
  if (depth > 20) throw new Error(`${label} exceeds the maximum depth.`);
  if (seen.has(value)) throw new Error(`${label} contains a cycle.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => key !== "length"
          && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)))) {
        throw new Error(`${label} array contains a custom property.`);
      }
      const lengthDescriptor = descriptors.length;
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor)
          || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
        throw new Error(`${label} has an invalid array length.`);
      }
      const length = lengthDescriptor.value as number;
      if (length > MAX_ITEMS) throw new Error(`${label} exceeds the maximum array length.`);
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error(`${label}[${index}] must be an enumerable data item.`);
        }
        result.push(snapshotData(descriptor.value, `${label}[${index}]`, seen, depth + 1, budget));
      }
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain objects.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length > 1_000) {
      throw new Error(`${label} exceeds the maximum object width.`);
    }
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
      throw new Error(`${label} contains a symbol property.`);
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`${label}.${key} must be an enumerable data field.`);
      }
      result[key] = snapshotData(descriptor.value, `${label}.${key}`, seen, depth + 1, budget);
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}

function record(label: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function array(label: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
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

function timestamp(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 80
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
      || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return value;
}
