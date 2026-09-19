import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  INTERACTIVE_SESSION_LEASE_SCHEMA, InteractiveSessionLeaseError,
  type InteractiveSessionLeaseClaim, type InteractiveSessionLeaseMetadata,
} from "./interactive-session-contracts.js";

const MAX_METADATA_BYTES = 4_096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RESOURCE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u;
const OWNER_FILE = "owner.json";

export interface LeaseReadRuntime {
  readonly useNoFollow: boolean;
  /** Contract-test seam for a generation replacement before metadata lstat. */
  readonly afterDirectoryStat?: () => void | Promise<void>;
  /** Contract-test seam for a replacement between metadata lstat and open. */
  readonly afterInitialStat?: () => void | Promise<void>;
}

export interface LeasePublishRuntime {
  readonly cleanupTemporary: (path: string) => Promise<void>;
  readonly renameDirectory: (source: string, destination: string) => Promise<void>;
}

export interface LeaseRetireRuntime {
  /** Contract-test seam for a competing retire/new publication interleaving. */
  readonly beforeRename?: () => void | Promise<void>;
}

export type PublishLeaseResult = { readonly status: "occupied" | "acquired" };

const defaultReadRuntime: LeaseReadRuntime = Object.freeze({
  useNoFollow: typeof constants.O_NOFOLLOW === "number",
});
const defaultPublishRuntime: LeasePublishRuntime = Object.freeze({
  cleanupTemporary: cleanupDirectory,
  renameDirectory: rename,
});

export function validateLeaseLocation(directory: unknown, name: unknown): { directory: string; name: string; lockPath: string } {
  if (typeof directory !== "string" || directory.length === 0 || directory.length > 4_096
    || directory.includes("\0") || !path.isAbsolute(directory) || path.resolve(directory) !== directory) {
    throw new InteractiveSessionLeaseError("invalidOptions", "Lease directory must be a normalized absolute path.");
  }
  if (typeof name !== "string" || !RESOURCE.test(name)) {
    throw new InteractiveSessionLeaseError("invalidOptions", "Lease name must be a 1-64 character portable identifier.");
  }
  return { directory, name, lockPath: path.join(directory, `${name}.lease`) };
}

export async function ensureLeaseDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new InteractiveSessionLeaseError("invalidOptions", "Lease directory must be a real directory, not a symbolic link.");
  }
}

export function serializeMetadata(metadata: InteractiveSessionLeaseMetadata): string {
  return `${JSON.stringify(metadata)}\n`;
}

export async function publishLease(lockPath: string, metadata: InteractiveSessionLeaseMetadata,
  runtime: LeasePublishRuntime = defaultPublishRuntime): Promise<PublishLeaseResult> {
  const temporary = `${lockPath}.pending-${metadata.leaseToken}`;
  let created = false;
  try {
    await mkdir(temporary, { mode: 0o700 });
    created = true;
    await writeMetadata(path.join(temporary, OWNER_FILE), metadata);
    try {
      await runtime.renameDirectory(temporary, lockPath);
      return Object.freeze({ status: "acquired" });
    } catch (error) {
      if (!isDestinationOccupied(error)) throw error;
    }
  } catch (error) {
    if (created) await runtime.cleanupTemporary(temporary);
    throw error;
  }
  await runtime.cleanupTemporary(temporary);
  return Object.freeze({ status: "occupied" });
}

export async function readLease(lockPath: string,
  runtime: LeaseReadRuntime = defaultReadRuntime): Promise<InteractiveSessionLeaseMetadata | null> {
  let directoryInfo;
  try { directoryInfo = await lstat(lockPath, { bigint: true }); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw corrupt("Lease path cannot be inspected.");
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.ino === 0n) {
    throw corrupt("Lease path must be a real owner directory.");
  }
  await runtime.afterDirectoryStat?.();
  let metadata: InteractiveSessionLeaseMetadata;
  try { metadata = await readMetadataFile(path.join(lockPath, OWNER_FILE), runtime); }
  catch (error) {
    if (!await generationIsCurrent(lockPath, directoryInfo.dev, directoryInfo.ino)) return null;
    throw error;
  }
  if (!await generationIsCurrent(lockPath, directoryInfo.dev, directoryInfo.ino)) return null;
  return metadata;
}

export async function moveLeaseToProof(lockPath: string, metadata: InteractiveSessionLeaseMetadata,
  _kind: "released" | "stale", runtime: LeaseRetireRuntime = {}): Promise<boolean> {
  const existing = await readLease(lockPath);
  if (existing === null || !sameOwner(existing, metadata)) return false;
  const retired = `${lockPath}.retired-${metadata.leaseToken}`;
  if (await pathExists(retired)) return false;
  await runtime.beforeRename?.();
  try { await rename(lockPath, retired); }
  catch (error) {
    if (await pathExists(retired) || !await pathExists(lockPath)) return false;
    throw error;
  }
  const proof = await readLease(retired);
  if (proof === null || !sameOwner(proof, metadata)) {
    throw corrupt("Retired lease proof does not match the ownership being released.");
  }
  return true;
}

export function metadataFromClaim(claim: InteractiveSessionLeaseClaim): InteractiveSessionLeaseMetadata {
  return Object.freeze({ schema: INTERACTIVE_SESSION_LEASE_SCHEMA, resource: claim.name,
    pid: claim.pid, processCreationMarker: claim.processCreationMarker,
    ownerNonce: claim.ownerNonce, leaseToken: claim.leaseToken, acquiredAt: claim.acquiredAt });
}

export function sameOwner(left: InteractiveSessionLeaseMetadata, right: InteractiveSessionLeaseMetadata): boolean {
  return left.schema === right.schema && left.resource === right.resource && left.pid === right.pid
    && left.processCreationMarker === right.processCreationMarker && left.ownerNonce === right.ownerNonce
    && left.leaseToken === right.leaseToken && left.acquiredAt === right.acquiredAt;
}

async function readMetadataFile(file: string, runtime: LeaseReadRuntime): Promise<InteractiveSessionLeaseMetadata> {
  let before;
  try { before = await lstat(file, { bigint: true }); }
  catch { throw corrupt("Lease owner metadata is missing or cannot be inspected."); }
  if (!before.isFile() || before.isSymbolicLink() || before.ino === 0n) {
    throw corrupt("Lease owner metadata must be an identifiable regular file.");
  }
  await runtime.afterInitialStat?.();
  let handle;
  try {
    const noFollow = runtime.useNoFollow && typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(file, constants.O_RDONLY | noFollow);
  } catch { throw corrupt("Lease owner metadata cannot be opened as a regular file."); }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.ino === 0n || info.dev !== before.dev || info.ino !== before.ino) {
      throw corrupt("Lease owner metadata identity changed between inspection and open.");
    }
    // Windows has no O_NOFOLLOW. Re-inspect the directory entry after open so a
    // same-inode symlink swap cannot pass merely because the opened target still
    // has the identity observed before the swap. This narrows the fallback race;
    // it does not claim to eliminate hostile-filesystem TOCTOU in general.
    if (!runtime.useNoFollow) {
      let current;
      try { current = await lstat(file, { bigint: true }); }
      catch { throw corrupt("Lease owner metadata changed while it was being opened."); }
      if (!current.isFile() || current.isSymbolicLink() || current.ino === 0n
          || current.dev !== info.dev || current.ino !== info.ino) {
        throw corrupt("Lease owner metadata path changed while it was being opened.");
      }
    }
    if (info.size < 2n || info.size > BigInt(MAX_METADATA_BYTES)) throw corrupt("Lease metadata file size is invalid.");
    return parseMetadata(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

async function writeMetadata(file: string, metadata: InteractiveSessionLeaseMetadata): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(serializeMetadata(metadata), "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

async function cleanupDirectory(directory: string): Promise<void> {
  try { await unlink(path.join(directory, OWNER_FILE)); }
  catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  await rmdir(directory);
}

function parseMetadata(source: string): InteractiveSessionLeaseMetadata {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw corrupt("Lease metadata is not valid canonical JSON."); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw corrupt("Lease metadata must be an object.");
  const record = value as Record<string, unknown>;
  const expected = ["schema", "resource", "pid", "processCreationMarker", "ownerNonce", "leaseToken", "acquiredAt"];
  if (Object.keys(record).length !== expected.length || expected.some((key) => !(key in record))) {
    throw corrupt("Lease metadata fields do not match schema 1.");
  }
  if (record.schema !== INTERACTIVE_SESSION_LEASE_SCHEMA || typeof record.resource !== "string"
    || !RESOURCE.test(record.resource) || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
    || typeof record.processCreationMarker !== "string" || record.processCreationMarker.length < 3
    || record.processCreationMarker.length > 256 || /[\r\n\0]/u.test(record.processCreationMarker)
    || typeof record.ownerNonce !== "string" || !UUID.test(record.ownerNonce)
    || typeof record.leaseToken !== "string" || !UUID.test(record.leaseToken)
    || typeof record.acquiredAt !== "string" || !isCanonicalDate(record.acquiredAt)) {
    throw corrupt("Lease metadata contains invalid field values.");
  }
  const metadata = record as unknown as InteractiveSessionLeaseMetadata;
  if (serializeMetadata(metadata) !== source) throw corrupt("Lease metadata is not canonical or contains duplicate fields.");
  return Object.freeze(metadata);
}

async function pathExists(candidate: string): Promise<boolean> {
  try { await lstat(candidate); return true; }
  catch (error) { if (errorCode(error) === "ENOENT") return false; throw error; }
}
async function generationIsCurrent(lockPath: string, dev: bigint, ino: bigint): Promise<boolean> {
  try {
    const current = await lstat(lockPath, { bigint: true });
    return current.isDirectory() && !current.isSymbolicLink() && current.dev === dev && current.ino === ino;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw corrupt("Lease generation cannot be re-inspected safely.");
  }
}
function isCanonicalDate(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
function corrupt(message: string): InteractiveSessionLeaseError {
  return new InteractiveSessionLeaseError("corruptLease", message);
}
function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code : undefined;
}
function isDestinationOccupied(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EEXIST" || code === "ENOTEMPTY";
}
