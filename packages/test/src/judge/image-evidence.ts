import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";

import { JUDGE_LIMITS, type ImageMediaType } from "@surfaceloom/llm-judge";
import type { SourceArtifact } from "@surfaceloom/reporter";

import { normalizeCompleteness, type EvidenceCompleteness } from "../evidence/content.js";
import {
  assertIssuedExecutionScope,
  identifier,
  type ExecutionScope,
} from "../evidence/execution-scope.js";
import { jsonSnapshot } from "../evidence/json-data.js";
import type { CaseImageEvidenceSubmissionV3 } from "./contracts.js";

export interface CollectedImageEvidenceV3 {
  readonly submissionId: string;
  readonly artifactId: string;
  readonly mediaType: ImageMediaType;
  readonly bytes: Uint8Array;
  readonly completeness: EvidenceCompleteness;
  readonly correlationId?: string;
  readonly capturedAt: string;
}

export interface ImageEvidenceSnapshotV3 {
  readonly scope: ExecutionScope;
  readonly artifacts: readonly CollectedImageEvidenceV3[];
}

export interface MaterializedImageEvidenceIntegrityV3 {
  readonly artifactId: string;
  readonly sourcePath: string;
  readonly mediaType: ImageMediaType;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface MaterializedImageEvidenceV3 {
  readonly scope: ExecutionScope;
  readonly artifacts: readonly SourceArtifact[];
}

interface ReceiptRecord {
  readonly snapshot: ImageEvidenceSnapshotV3;
  readonly integrity: readonly MaterializedImageEvidenceIntegrityV3[];
}

const snapshots = new WeakSet<object>();
const receipts = new WeakMap<object, ReceiptRecord>();

/** Current-attempt byte collector. It accepts no URL or filesystem path. */
export class ImageEvidenceCollectorV3 {
  readonly #scope: ExecutionScope;
  readonly #items: CollectedImageEvidenceV3[] = [];
  readonly #ids = new Set<string>();
  readonly #artifactIds = new Set<string>();
  #totalBytes = 0;
  #sealed = false;

  constructor(scope: ExecutionScope) {
    assertIssuedExecutionScope(scope);
    this.#scope = scope;
  }

  submit(input: CaseImageEvidenceSubmissionV3): void {
    if (this.#sealed) throw new Error("Late image evidence submission after seal.");
    const fields = plainData(input, "image evidence submission", [
      "id", "artifactId", "mediaType", "bytes", "completeness", "correlationId",
    ]);
    const id = identifier("image evidence submission id", required(fields, "id"));
    const artifactId = identifier("image evidence artifactId", required(fields, "artifactId"));
    if (this.#ids.has(id)) throw new Error("Duplicate image evidence submission id.");
    if (this.#artifactIds.has(artifactId)) throw new Error("Duplicate image evidence artifact id.");
    if (this.#items.length >= JUDGE_LIMITS.maxEvidenceItems) {
      throw new Error("Image evidence submission limit exceeded.");
    }
    const mediaType = imageMediaType(required(fields, "mediaType"));
    const bytesValue = required(fields, "bytes");
    if (!(bytesValue instanceof Uint8Array) || types.isProxy(bytesValue)
        || (!Buffer.isBuffer(bytesValue) && Object.getPrototypeOf(bytesValue) !== Uint8Array.prototype)) {
      throw new Error("Image evidence bytes must be a non-Proxy Uint8Array.");
    }
    const bytes = Buffer.from(bytesValue);
    if (bytes.byteLength === 0 || bytes.byteLength > JUDGE_LIMITS.maxImageBytesPerEvidence) {
      throw new Error("Image evidence exceeds its per-item byte budget.");
    }
    if (this.#totalBytes + bytes.byteLength > JUDGE_LIMITS.maxTotalImageBytes) {
      throw new Error("Image evidence exceeds its total byte budget.");
    }
    assertMagic(bytes, mediaType);
    const completenessValue = optional(fields, "completeness");
    const completenessInput = completenessValue === undefined ? { state: "complete" } as const
      : jsonSnapshot(completenessValue, "image evidence completeness") as EvidenceCompleteness;
    const completeness = normalizeCompleteness(completenessInput, []);
    const correlationValue = optional(fields, "correlationId");
    const correlationId = correlationValue === undefined ? undefined
      : identifier("image evidence correlationId", correlationValue);
    this.#items.push(Object.freeze({ submissionId: id, artifactId, mediaType,
      bytes: Uint8Array.from(bytes), completeness,
      ...(correlationId === undefined ? {} : { correlationId }),
      capturedAt: new Date().toISOString() }));
    this.#ids.add(id);
    this.#artifactIds.add(artifactId);
    this.#totalBytes += bytes.byteLength;
  }

  seal(): ImageEvidenceSnapshotV3 {
    if (this.#sealed) throw new Error("Image evidence collector is already sealed.");
    this.#sealed = true;
    const snapshot = Object.freeze({ scope: this.#scope,
      artifacts: Object.freeze([...this.#items]) });
    snapshots.add(snapshot);
    return snapshot;
  }
}

export async function materializeImageEvidenceV3(snapshot: ImageEvidenceSnapshotV3,
  stagingDirectory: string): Promise<MaterializedImageEvidenceV3> {
  assertImageSnapshot(snapshot);
  const root = path.resolve(stagingDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const artifacts: SourceArtifact[] = [];
  const integrity: MaterializedImageEvidenceIntegrityV3[] = [];
  for (const [index, item] of snapshot.artifacts.entries()) {
    const sourcePath = path.join(root,
      `${String(index + 1).padStart(4, "0")}-judge-image-${safe(item.artifactId)}.${extension(item.mediaType)}`);
    const bytes = Buffer.from(item.bytes);
    await writeFile(sourcePath, bytes, { flag: "wx", mode: 0o600 });
    integrity.push(Object.freeze({ artifactId: item.artifactId, sourcePath,
      mediaType: item.mediaType, sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex") }));
    artifacts.push(Object.freeze({ id: item.artifactId, kind: "screenshot", phase: "after",
      title: "Judge image evidence", captureStatus: "captured", sourcePath,
      contentType: item.mediaType, capturedAt: item.capturedAt, reviewPriority: "primary",
      ...(item.completeness.state === "incomplete"
        ? { description: "Image evidence is incomplete; Judge was not invoked." } : {}) }));
  }
  const receipt = Object.freeze({ scope: snapshot.scope, artifacts: Object.freeze(artifacts) });
  receipts.set(receipt, Object.freeze({ snapshot, integrity: Object.freeze(integrity) }));
  return receipt;
}

export function assertMaterializedImageEvidenceV3(receipt: MaterializedImageEvidenceV3,
  snapshot: ImageEvidenceSnapshotV3): void {
  const record = receipts.get(receipt as object);
  if (record === undefined) throw new Error("Materialized image receipt was not runner-issued.");
  assertImageSnapshot(snapshot);
  if (record.snapshot !== snapshot || receipt.scope !== snapshot.scope) {
    throw new Error("Materialized image receipt does not belong to this attempt.");
  }
  for (const expected of record.integrity) {
    let bytes: Buffer;
    try { bytes = readFileSync(expected.sourcePath); }
    catch { throw new Error(`Materialized image bytes are missing for ${expected.artifactId}.`); }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== expected.sizeBytes || digest !== expected.sha256) {
      throw new Error(`Materialized image bytes changed for ${expected.artifactId}.`);
    }
    assertMagic(bytes, expected.mediaType);
  }
}

export function materializedImageIntegrityV3(receipt: MaterializedImageEvidenceV3,
  snapshot: ImageEvidenceSnapshotV3): readonly MaterializedImageEvidenceIntegrityV3[] {
  assertMaterializedImageEvidenceV3(receipt, snapshot);
  return receipts.get(receipt as object)!.integrity;
}

function assertImageSnapshot(value: ImageEvidenceSnapshotV3): void {
  if (!snapshots.has(value)) throw new Error("Image evidence snapshot was not runner-issued.");
  assertIssuedExecutionScope(value.scope);
}

function plainData(input: unknown, label: string, allowed: readonly string[]):
  Record<PropertyKey, PropertyDescriptor> {
  if (typeof input !== "object" || input === null || types.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new Error(`${label} must be a plain data object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new Error(`${label} contains unknown metadata.`);
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label}.${key} must be an enumerable data field.`);
    }
  }
  return descriptors;
}

function required(fields: Record<PropertyKey, PropertyDescriptor>, key: string): unknown {
  const descriptor = fields[key];
  if (descriptor === undefined || !("value" in descriptor)) throw new Error(`Image evidence ${key} is required.`);
  return descriptor.value;
}

function optional(fields: Record<PropertyKey, PropertyDescriptor>, key: string): unknown {
  const descriptor = fields[key];
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function imageMediaType(value: unknown): ImageMediaType {
  if (value !== "image/png" && value !== "image/jpeg" && value !== "image/webp") {
    throw new Error("Image evidence mediaType is unsupported.");
  }
  return value;
}

function assertMagic(bytes: Uint8Array, mediaType: ImageMediaType): void {
  const ok = mediaType === "image/png"
    ? bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((value, index) => bytes[index] === value)
    : mediaType === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF"
        && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
  if (!ok) throw new Error(`Image evidence bytes do not match ${mediaType}.`);
}

function extension(mediaType: ImageMediaType): string {
  return mediaType === "image/png" ? "png" : mediaType === "image/jpeg" ? "jpg" : "webp";
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 80);
}
