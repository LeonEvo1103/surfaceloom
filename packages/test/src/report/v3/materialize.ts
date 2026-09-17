import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SourceArtifact } from "@surfaceloom/reporter";

import {
  assertEvidenceCollectionSnapshot,
  type CollectedEvidenceArtifact,
  type EvidenceCollectionSnapshot,
} from "../../evidence/collector.js";
import { assertIssuedExecutionScope, type ExecutionScope } from "../../evidence/execution-scope.js";
import type { MaterializedEvidenceV3 } from "./contracts.js";

const schemaVersion = "surfaceloom.runner-evidence/v1" as const;

export interface MaterializedEvidenceIntegrity {
  readonly artifactId: string;
  readonly sourcePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface ReceiptRecord {
  readonly snapshot: EvidenceCollectionSnapshot;
  readonly scope: ExecutionScope;
  readonly integrity: readonly MaterializedEvidenceIntegrity[];
}

const issuedReceipts = new WeakMap<object, ReceiptRecord>();

/** Writes normalized, redacted JSON staging files for Reporter to copy into its bundle. */
export async function materializeEvidenceV3(
  snapshot: EvidenceCollectionSnapshot,
  stagingDirectory: string,
): Promise<MaterializedEvidenceV3> {
  assertEvidenceCollectionSnapshot(snapshot);
  assertIssuedExecutionScope(snapshot.scope);
  const root = path.resolve(stagingDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const artifacts: SourceArtifact[] = [];
  const integrity: MaterializedEvidenceIntegrity[] = [];
  for (const [index, item] of snapshot.artifacts.entries()) {
    const sourcePath = path.join(root, filename(index, item.artifact.artifactId));
    integrity.push(await writeJSON(sourcePath, item.artifact.artifactId, {
      schemaVersion,
      scope: snapshot.scope,
      submissionId: item.submissionId,
      source: item.source,
      artifact: item.artifact,
      completeness: item.completeness,
      ...(item.correlationId === undefined ? {} : { correlationId: item.correlationId }),
      content: item.content,
    }));
    artifacts.push(sourceArtifact(item, sourcePath));
  }
  const graphPath = path.join(root, filename(snapshot.artifacts.length, snapshot.graphArtifactId));
  integrity.push(await writeJSON(graphPath, snapshot.graphArtifactId, {
    schemaVersion,
    scope: snapshot.scope,
    completeness: snapshot.completeness,
    evidenceContext: snapshot.context,
  }));
  artifacts.push(Object.freeze({
    id: snapshot.graphArtifactId,
    kind: "diagnostics",
    phase: "after",
    title: "Evidence graph",
    captureStatus: "captured",
    sourcePath: graphPath,
    contentType: "application/json",
    capturedAt: snapshot.graphCapturedAt,
    reviewPriority: "primary",
    relatedArtifactIds: Object.freeze(snapshot.artifacts.map((item) => item.artifact.artifactId)),
    ...(snapshot.completeness.state === "incomplete"
      ? { description: "Evidence graph is incomplete; no missing fact was inferred." }
      : {}),
  }));
  const receipt = Object.freeze({ scope: snapshot.scope, artifacts: Object.freeze(artifacts) });
  issueReceipt(receipt, snapshot, integrity);
  return receipt;
}

/** Brand lookup happens before any receipt field is read. */
export function assertMaterializedEvidenceV3(receipt: MaterializedEvidenceV3,
  snapshot: EvidenceCollectionSnapshot): void {
  const record = issuedReceipts.get(receipt as object);
  if (record === undefined) throw new Error("Materialized evidence receipt was not runner-issued.");
  assertEvidenceCollectionSnapshot(snapshot);
  if (record.snapshot !== snapshot || record.scope !== snapshot.scope) {
    throw new Error("Materialized evidence receipt does not belong to this evidence snapshot.");
  }
  for (const expected of record.integrity) {
    let bytes: Buffer;
    try { bytes = readFileSync(expected.sourcePath); }
    catch { throw new Error(`Materialized evidence bytes are missing for ${expected.artifactId}.`); }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== expected.sizeBytes || sha256 !== expected.sha256) {
      throw new Error(`Materialized evidence bytes changed for ${expected.artifactId}.`);
    }
  }
}

export function materializedEvidenceIntegrity(receipt: MaterializedEvidenceV3,
  snapshot: EvidenceCollectionSnapshot): readonly MaterializedEvidenceIntegrity[] {
  assertMaterializedEvidenceV3(receipt, snapshot);
  return issuedReceipts.get(receipt as object)!.integrity;
}

/** Deliberately private: materializeEvidenceV3 is the only receipt issuer. */
function issueReceipt(receipt: MaterializedEvidenceV3, snapshot: EvidenceCollectionSnapshot,
  integrity: readonly MaterializedEvidenceIntegrity[]): void {
  issuedReceipts.set(receipt, Object.freeze({ snapshot, scope: snapshot.scope,
    integrity: Object.freeze([...integrity]) }));
}

function sourceArtifact(item: CollectedEvidenceArtifact, sourcePath: string): SourceArtifact {
  return Object.freeze({
    id: item.artifact.artifactId,
    kind: item.content.kind === "trace" ? "trace" : "diagnostics",
    phase: "after",
    title: item.content.kind === "trace" ? "Normalized trace" : "Normalized evidence",
    captureStatus: "captured",
    sourcePath,
    contentType: "application/json",
    capturedAt: item.capturedAt,
    reviewPriority: "primary",
    ...(item.completeness.state === "incomplete"
      ? { description: "Evidence is incomplete; no missing fact was inferred." }
      : {}),
  });
}

async function writeJSON(destination: string, artifactId: string,
  value: unknown): Promise<MaterializedEvidenceIntegrity> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
  return Object.freeze({ artifactId, sourcePath: destination, sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex") });
}

function filename(index: number, id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 80);
  return `${String(index + 1).padStart(4, "0")}-${safe}.json`;
}
