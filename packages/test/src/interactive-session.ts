import { randomUUID } from "node:crypto";
import process from "node:process";
import { types } from "node:util";
import {
  INTERACTIVE_SESSION_LEASE_SCHEMA, InteractiveSessionLeaseError,
  type AcquireInteractiveSessionLeaseOptions, type InteractiveSessionLease,
  type InteractiveSessionLeaseClaim, type InteractiveSessionLeaseMetadata,
  type InteractiveSessionReleaseReceipt,
} from "./interactive-session-contracts.js";
import { currentProcessCreationMarker, observeProcessIdentity } from "./interactive-session-process.js";
import {
  ensureLeaseDirectory, metadataFromClaim, moveLeaseToProof, publishLease, readLease,
  sameOwner, validateLeaseLocation,
} from "./interactive-session-storage.js";

export type {
  AcquireInteractiveSessionLeaseOptions, InteractiveSessionLease, InteractiveSessionLeaseClaim,
  InteractiveSessionReleaseReceipt,
} from "./interactive-session-contracts.js";
export { InteractiveSessionLeaseError } from "./interactive-session-contracts.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_MS = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * SL-P2-080 process-wide GUI/input exclusivity. Acquisition publishes complete metadata atomically.
 * A close/kill observation is never a release receipt: release is confirmed only after the owned
 * directory is atomically renamed to its permanent token-specific retirement proof.
 */
export async function acquireInteractiveSessionLease(
  options: AcquireInteractiveSessionLeaseOptions,
): Promise<InteractiveSessionLease> {
  const snapshot = snapshotOptions(options);
  const location = validateLeaseLocation(snapshot.directory, snapshot.name);
  await ensureLeaseDirectory(location.directory);
  throwIfAborted(snapshot.signal);
  const processCreationMarker = await currentProcessCreationMarker();
  if (processCreationMarker === null) {
    throw new InteractiveSessionLeaseError("processIdentityUnavailable",
      "The current process creation marker cannot be observed on this platform.");
  }
  const startedAt = performance.now();
  let attempt = 0;
  let cycles = 0;
  while (true) {
    throwIfAborted(snapshot.signal);
    if (cycles > 0 && performance.now() - startedAt >= snapshot.timeoutMs) throw timedOut(location.name);
    cycles += 1;
    const existing = await readLease(location.lockPath);
    if (existing !== null) {
      if (existing.resource !== location.name) {
        throw new InteractiveSessionLeaseError("corruptLease", "Lease metadata resource does not match its pathname.");
      }
      if (await isDefinitelyStale(existing)
        && await moveLeaseToProof(location.lockPath, existing, "stale")) continue;
      const elapsed = performance.now() - startedAt;
      if (elapsed >= snapshot.timeoutMs) throw timedOut(location.name);
      const capped = Math.min(snapshot.retryIntervalMs * (1 + Math.floor(attempt / 4)), 250);
      const delayMs = Math.min(capped + Math.floor(Math.random() * Math.max(1, capped / 4)),
        snapshot.timeoutMs - elapsed);
      attempt += 1;
      await abortableDelay(delayMs, snapshot.signal);
      continue;
    }
    const acquiredAt = new Date().toISOString();
    const metadata: InteractiveSessionLeaseMetadata = Object.freeze({
      schema: INTERACTIVE_SESSION_LEASE_SCHEMA, resource: location.name, pid: process.pid,
      processCreationMarker, ownerNonce: randomUUID(), leaseToken: randomUUID(), acquiredAt,
    });
    const publication = await publishLease(location.lockPath, metadata);
    if (publication.status === "acquired") {
      if (snapshot.signal?.aborted) {
        if (!await moveLeaseToProof(location.lockPath, metadata, "released")) {
          throw new InteractiveSessionLeaseError("notOwner",
            "Lease ownership changed while cancelling a completed acquisition.");
        }
        throwIfAborted(snapshot.signal);
      }
      return createLease(location.directory, location.name, location.lockPath, metadata);
    }
  }
}

export async function releaseInteractiveSessionLease(
  input: InteractiveSessionLeaseClaim,
): Promise<InteractiveSessionReleaseReceipt> {
  const claim = snapshotClaim(input);
  const location = validateLeaseLocation(claim.directory, claim.name);
  validateClaim(claim);
  const marker = await currentProcessCreationMarker();
  if (claim.pid !== process.pid || marker === null || marker !== claim.processCreationMarker) {
    throw new InteractiveSessionLeaseError("notOwner", "Only the process identity that acquired the lease may release it.");
  }
  const expected = metadataFromClaim(claim);
  const existing = await readLease(location.lockPath);
  if (existing === null || !sameOwner(existing, expected)) {
    throw new InteractiveSessionLeaseError("notOwner", "Lease ownership changed before release could be confirmed.");
  }
  if (!await moveLeaseToProof(location.lockPath, expected, "released")) {
    throw new InteractiveSessionLeaseError("notOwner", "Lease ownership changed during release.");
  }
  return Object.freeze({ status: "released" });
}

function createLease(directory: string, name: string, lockPath: string,
  metadata: InteractiveSessionLeaseMetadata): InteractiveSessionLease {
  const claim: InteractiveSessionLeaseClaim = Object.freeze({ directory, name, pid: metadata.pid,
    processCreationMarker: metadata.processCreationMarker, ownerNonce: metadata.ownerNonce,
    leaseToken: metadata.leaseToken, acquiredAt: metadata.acquiredAt });
  let receipt: InteractiveSessionReleaseReceipt | undefined;
  let releasing: Promise<InteractiveSessionReleaseReceipt> | undefined;
  const release = (): Promise<InteractiveSessionReleaseReceipt> => {
    if (receipt !== undefined) return Promise.resolve(receipt);
    if (releasing !== undefined) return releasing;
    releasing = releaseInteractiveSessionLease(claim).then((value) => { receipt = value; return value; })
      .finally(() => { releasing = undefined; });
    return releasing;
  };
  return Object.freeze({ ...claim, path: lockPath, diagnostics: Object.freeze([]), release });
}

async function isDefinitelyStale(metadata: InteractiveSessionLeaseMetadata): Promise<boolean> {
  const observation = await observeProcessIdentity(metadata.pid);
  return observation.status === "absent"
    || observation.status === "present" && observation.creationMarker !== metadata.processCreationMarker;
}

function snapshotOptions(options: AcquireInteractiveSessionLeaseOptions) {
  const record = strictDataRecord(options,
    ["directory", "name", "timeoutMs", "retryIntervalMs", "signal"], "Lease options");
  const directory = record.directory;
  const name = record.name ?? "interactive-session";
  const timeoutMs = record.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryIntervalMs = record.retryIntervalMs ?? DEFAULT_RETRY_MS;
  const signal = record.signal;
  if (!validDuration(timeoutMs, true)) invalid("timeoutMs must be an integer from 0 through 2147483647.");
  if (!validDuration(retryIntervalMs, false) || retryIntervalMs > 1_000) {
    invalid("retryIntervalMs must be an integer from 1 through 1000.");
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid("signal must be an AbortSignal.");
  return { directory, name, timeoutMs, retryIntervalMs, signal };
}

function snapshotClaim(input: InteractiveSessionLeaseClaim): InteractiveSessionLeaseClaim {
  const record = strictDataRecord(input, ["directory", "name", "pid", "processCreationMarker",
    "ownerNonce", "leaseToken", "acquiredAt", "path", "diagnostics", "release"], "Lease claim");
  const claim = Object.freeze({ directory: record.directory, name: record.name, pid: record.pid,
    processCreationMarker: record.processCreationMarker, ownerNonce: record.ownerNonce,
    leaseToken: record.leaseToken, acquiredAt: record.acquiredAt }) as InteractiveSessionLeaseClaim;
  validateClaim(claim);
  return claim;
}

function validateClaim(claim: InteractiveSessionLeaseClaim): void {
  if (!Number.isSafeInteger(claim.pid) || claim.pid <= 0 || typeof claim.processCreationMarker !== "string"
    || claim.processCreationMarker.length < 3 || claim.processCreationMarker.length > 256
    || /[\r\n\0]/u.test(claim.processCreationMarker)
    || typeof claim.ownerNonce !== "string" || !UUID.test(claim.ownerNonce)
    || typeof claim.leaseToken !== "string" || !UUID.test(claim.leaseToken)
    || typeof claim.acquiredAt !== "string" || !Number.isFinite(Date.parse(claim.acquiredAt))
    || new Date(Date.parse(claim.acquiredAt)).toISOString() !== claim.acquiredAt) {
    invalid("Lease claim is invalid.");
  }
}

function strictDataRecord(input: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if ((typeof input !== "object" && typeof input !== "function") || input === null || types.isProxy(input)) {
    invalid(`${label} must be a non-proxy plain data object.`);
  }
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain data object.`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.includes(key)) invalid(`${label} contains an unexpected field.`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) invalid(`${label} fields must be own data properties.`);
    result[key] = descriptor.value;
  }
  return result;
}

function validDuration(value: unknown, zeroAllowed: boolean): value is number {
  return Number.isInteger(value) && (zeroAllowed ? (value as number) >= 0 : (value as number) > 0)
    && (value as number) <= 2_147_483_647;
}

function invalid(message: string): never { throw new InteractiveSessionLeaseError("invalidOptions", message); }
function timedOut(name: string) {
  return new InteractiveSessionLeaseError("timedOut", `Timed out waiting for interactive-session lease '${name}'.`);
}
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new InteractiveSessionLeaseError("aborted", "Interactive-session lease wait was aborted.");
}

function abortableDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      clearTimeout(timer);
      reject(new InteractiveSessionLeaseError("aborted", "Interactive-session lease wait was aborted."));
    };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, delayMs);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}
