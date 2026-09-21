import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Artifact } from "../execution.js";
import { parseRunId, type RunId } from "../ids.js";
import type { ArtifactStore, PutArtifactRequest, StoredArtifact } from "./contracts.js";
import { StoreConflictError, StoreCorruptionError } from "./contracts.js";
import { parseArtifact } from "./validation.js";

const defaultMaxArtifactBytes = 64 * 1024 * 1024;

export interface FileArtifactStoreOptions { readonly maxArtifactBytes?: number }

export class FileArtifactStore implements ArtifactStore {
  readonly #blobs: string;
  readonly #manifests: string;
  readonly #maxArtifactBytes: number;

  private constructor(root: string, options: FileArtifactStoreOptions) {
    this.#blobs = path.join(path.resolve(root), "blobs");
    this.#manifests = path.join(path.resolve(root), "manifests");
    this.#maxArtifactBytes = options.maxArtifactBytes ?? defaultMaxArtifactBytes;
    if (!Number.isSafeInteger(this.#maxArtifactBytes) || this.#maxArtifactBytes <= 0) {
      throw new TypeError("maxArtifactBytes must be a positive integer.");
    }
  }

  static async open(root: string, options: FileArtifactStoreOptions = {}): Promise<FileArtifactStore> {
    const store = new FileArtifactStore(root, options);
    await Promise.all([
      mkdir(store.#blobs, { recursive: true, mode: 0o700 }),
      mkdir(store.#manifests, { recursive: true, mode: 0o700 }),
    ]);
    return store;
  }

  async put(request: PutArtifactRequest): Promise<Artifact> {
    const runId = parseRunId(request.runId);
    const name = text(request.name, "Artifact name", 255);
    const mediaType = text(request.mediaType, "Artifact mediaType", 255);
    if (!(request.data instanceof Uint8Array)) throw new TypeError("Artifact data must be Uint8Array.");
    if (request.data.byteLength > this.#maxArtifactBytes) throw new StoreConflictError("Artifact exceeds the configured byte limit.");
    const data = Uint8Array.from(request.data);
    const digest = hash(data);
    const artifactId = `artifact:${hash(`${runId}\0${name}\0${mediaType}\0${digest}`)}`;
    const artifact = Object.freeze({ artifactId, runId, name, mediaType,
      sizeBytes: data.byteLength, sha256: digest });
    const manifestPath = this.#manifestPath(artifactId);
    const existing = await this.#readManifest(manifestPath);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(artifact)) throw new StoreConflictError("Artifact identity collision.");
      return existing;
    }
    await writeExclusive(this.#blobPath(digest), data);
    await writeExclusive(manifestPath, Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8"));
    return artifact;
  }

  async get(artifactId: string): Promise<StoredArtifact | undefined> {
    const artifact = await this.#readManifest(this.#manifestPath(text(artifactId, "artifactId", 128)));
    if (artifact === undefined) return undefined;
    const blobPath = this.#blobPath(artifact.sha256);
    const descriptor = await stat(blobPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (descriptor === undefined || !descriptor.isFile() || descriptor.size !== artifact.sizeBytes ||
      descriptor.size > this.#maxArtifactBytes) throw new StoreCorruptionError("Artifact blob metadata does not match.");
    const data = await readFile(blobPath);
    if (hash(data) !== artifact.sha256) throw new StoreCorruptionError("Artifact blob digest does not match.");
    return Object.freeze({ artifact, data: Uint8Array.from(data) });
  }

  async list(runId: RunId): Promise<readonly Artifact[]> {
    const parsed = parseRunId(runId);
    const entries = await readdir(this.#manifests);
    const values: Artifact[] = [];
    for (const entry of entries.sort()) {
      if (!/^[0-9a-f]{64}\.json$/u.test(entry)) continue;
      const artifact = await this.#readManifest(path.join(this.#manifests, entry));
      if (artifact?.runId === parsed) values.push(artifact);
    }
    return Object.freeze(values);
  }

  async #readManifest(target: string): Promise<Artifact | undefined> {
    let input: string;
    try { input = await readFile(target, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (Buffer.byteLength(input, "utf8") > 4096) throw new StoreCorruptionError("Artifact manifest is too large.");
    try { return parseArtifact(JSON.parse(input)); } catch (cause) {
      if (cause instanceof StoreCorruptionError) throw cause;
      throw new StoreCorruptionError("Artifact manifest is invalid.", { cause });
    }
  }

  #manifestPath(artifactId: string): string { return path.join(this.#manifests, `${hash(artifactId)}.json`); }
  #blobPath(digest: string): string { return path.join(this.#blobs, digest); }
}

async function writeExclusive(target: string, data: Uint8Array): Promise<void> {
  try { await writeFile(target, data, { flag: "wx", mode: 0o600 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function text(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes) throw new TypeError(`${label} is invalid.`);
  return value;
}
