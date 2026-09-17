import { types } from "node:util";

import type {
  BrowserCloseProof,
  BrowserSurfaceSessionPort,
  SurfaceBackendCall,
  SurfaceEvidenceSink,
} from "./contracts.js";

const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;

type Settlement =
  | { readonly state: "notStarted" }
  | { readonly state: "acquired"; readonly session: BrowserSurfaceSessionPort }
  | { readonly state: "failed"; readonly submitted: boolean; readonly reason: string };

export interface BrowserCleanupStop {
  /** The owning cleanup scope must abort this when it times out or is stopped. */
  readonly signal: AbortSignal;
  /** Absolute deadline on the same monotonic clock used by the controller. */
  readonly deadlineAt: number;
}

/** Descriptor-only snapshot shared by factory and direct controller construction. */
export function snapshotBrowserCleanupStop(value: BrowserCleanupStop | undefined,
  required: boolean): BrowserCleanupStop | undefined {
  if (value === undefined) {
    if (required) throw new Error("A leased browser requires an outer cleanup stop contract.");
    return undefined;
  }
  if (typeof value !== "object" || value === null || types.isProxy(value)
      || (Object.getPrototypeOf(value) !== Object.prototype
        && Object.getPrototypeOf(value) !== null)) {
    throw new Error("Browser cleanup stop contract must be a plain data object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !["signal", "deadlineAt"].includes(key))) {
    throw new Error("Browser cleanup stop contract contains unknown metadata.");
  }
  const signal = dataField(descriptors.signal, "cleanup stop signal");
  const deadlineAt = dataField(descriptors.deadlineAt, "cleanup stop deadline");
  if (typeof deadlineAt !== "number" || !Number.isFinite(deadlineAt)) {
    throw new Error("Browser cleanup stop deadline must be finite.");
  }
  assertNativeAbortSignal(signal);
  return Object.freeze({ signal, deadlineAt });
}

export type BrowserControllerReceipt =
  | { readonly status: "released" }
  | { readonly status: "unconfirmed"; readonly reason: string };

/** Owns acquisition/close identity and one sticky cleanup terminal result. */
export class BrowserAcquisitionController {
  readonly #surfaceId: string;
  readonly #evidence: SurfaceEvidenceSink;
  readonly #cleanupTimeoutMs: number;
  readonly #stop: BrowserCleanupStop | undefined;
  readonly #now: () => number;
  #settled: Promise<Settlement> = Promise.resolve({ state: "notStarted" });
  #cleanup: Promise<BrowserControllerReceipt> | undefined;
  #close: Promise<BrowserCloseProof> | undefined;
  #deadlineAt: number | undefined;
  #terminal: BrowserControllerReceipt | undefined;
  #observed: Settlement = { state: "notStarted" };

  constructor(surfaceId: string, evidence: SurfaceEvidenceSink, cleanupTimeoutMs: number,
    stop?: BrowserCleanupStop, now: () => number = () => performance.now()) {
    this.#surfaceId = surfaceId;
    this.#evidence = evidence;
    this.#cleanupTimeoutMs = cleanupTimeoutMs;
    this.#stop = snapshotBrowserCleanupStop(stop, false);
    this.#now = now;
  }

  watch(pending: Promise<BrowserSurfaceSessionPort>, call: SurfaceBackendCall & { submitted: boolean }): void {
    this.#settled = pending.then((session) => {
      const settled = Object.freeze({ state: "acquired" as const, session });
      this.#observed = settled;
      return settled;
    }, (error: unknown) => {
      const settled = Object.freeze({ state: "failed" as const, submitted: call.submitted,
        reason: message(error) });
      this.#observed = settled;
      return settled;
    });
    void this.#settled.then((settled) => {
      if (this.#cleanup !== undefined && settled.state === "acquired") {
        void this.startClose(settled.session).catch(() => undefined);
      }
    });
  }

  cleanup(): Promise<BrowserControllerReceipt> {
    if (this.#cleanup !== undefined) return this.#cleanup;
    const now = this.#now();
    this.#deadlineAt = Math.min(now + this.#cleanupTimeoutMs,
      this.#stop?.deadlineAt ?? Number.POSITIVE_INFINITY);
    this.#cleanup = this.cleanupOnce(this.#deadlineAt).then((receipt) => {
      this.#terminal = receipt;
      return receipt;
    });
    return this.#cleanup;
  }

  /** Lease release is separate and must re-check the same cleanup boundary. */
  leaseReleaseAllowed(): boolean {
    return this.#terminal?.status === "released" && this.#deadlineAt !== undefined
      && !this.stopped(this.#deadlineAt);
  }

  private async cleanupOnce(deadlineAt: number): Promise<BrowserControllerReceipt> {
    let settled: Settlement;
    try { settled = await this.untilStop(this.#settled, deadlineAt); }
    catch (error) {
      if (this.#observed.state === "acquired") {
        void this.startClose(this.#observed.session).catch(() => undefined);
      }
      return unconfirmed(`Browser cleanup stopped: ${message(error)}`);
    }
    if (this.stopped(deadlineAt)) {
      if (settled.state === "acquired") void this.startClose(settled.session).catch(() => undefined);
      return unconfirmed("Browser cleanup deadline expired.");
    }
    if (settled.state === "notStarted" || (settled.state === "failed" && !settled.submitted)) {
      return released();
    }
    if (settled.state === "failed") return unconfirmed(`Browser acquisition is unknown: ${settled.reason}`);
    try {
      const proof = await this.untilStop(this.startClose(settled.session), deadlineAt);
      if (this.stopped(deadlineAt)) return unconfirmed("Browser cleanup deadline expired.");
      if (!matches(proof, settled.session)) {
        return unconfirmed("Browser close proof did not match the session.");
      }
      try {
        this.#evidence.submit({ kind: "cleanup", surfaceId: this.#surfaceId, outcome: "succeeded" });
      } catch (error) {
        return unconfirmed(`Browser cleanup evidence failed: ${message(error)}`);
      }
      if (this.stopped(deadlineAt)) return unconfirmed("Browser cleanup deadline expired.");
      return released();
    } catch (error) {
      try { this.#evidence.submit({ kind: "cleanup", surfaceId: this.#surfaceId, outcome: "failed" }); }
      catch { /* first cleanup failure remains primary and sticky */ }
      return unconfirmed(`Browser close failed: ${message(error)}`);
    }
  }

  private startClose(session: BrowserSurfaceSessionPort): Promise<BrowserCloseProof> {
    if (this.#close === undefined) {
      try { this.#close = Promise.resolve(session.close()); }
      catch (error) { this.#close = Promise.reject(error); }
    }
    return this.#close;
  }

  private async untilStop<T>(pending: Promise<T>, deadlineAt: number): Promise<T> {
    if (this.stopped(deadlineAt)) throw new Error("cleanup deadline expired");
    const remaining = Math.max(0, Math.floor(deadlineAt - this.#now()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("cleanup deadline expired")), remaining);
      if (this.#stop !== undefined) {
        abortListener = () => reject(new Error("owning cleanup scope stopped"));
        addEventListener.call(this.#stop.signal, "abort", abortListener, { once: true });
      }
    });
    try {
      const result = await Promise.race([pending, stopped]);
      if (this.stopped(deadlineAt)) throw new Error("cleanup deadline expired");
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortListener !== undefined && this.#stop !== undefined) {
        removeEventListener.call(this.#stop.signal, "abort", abortListener);
      }
    }
  }

  private stopped(deadlineAt: number): boolean {
    return this.#now() >= deadlineAt
      || (this.#stop !== undefined && nativeSignalAborted(this.#stop.signal));
  }
}

function dataField(descriptor: PropertyDescriptor | undefined, label: string): unknown {
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new Error(`${label} must be an enumerable data field.`);
  }
  return descriptor.value;
}

function assertNativeAbortSignal(value: unknown): asserts value is AbortSignal {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    throw new Error("Browser cleanup stop signal must be a native AbortSignal.");
  }
  try { nativeSignalAborted(value as AbortSignal); }
  catch { throw new Error("Browser cleanup stop signal must be a native AbortSignal."); }
}

function nativeSignalAborted(signal: AbortSignal): boolean {
  if (abortedGetter === undefined) throw new Error("AbortSignal is unavailable.");
  return Boolean(abortedGetter.call(signal));
}

function matches(proof: BrowserCloseProof, session: BrowserSurfaceSessionPort): boolean {
  return proof.kind === "browserSessionClosed" && proof.hostId === session.identity.hostId
    && proof.sessionId === session.identity.sessionId;
}
function released(): BrowserControllerReceipt { return Object.freeze({ status: "released" }); }
function unconfirmed(reason: string): BrowserControllerReceipt {
  return Object.freeze({ status: "unconfirmed", reason });
}
function message(error: unknown): string { return error instanceof Error ? error.message : "unknown error"; }
