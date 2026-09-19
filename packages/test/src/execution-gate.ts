import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import type { ResourceCleanupReceipt } from "./resources-contracts.js";
import {
  publishGateState, readGateState, retireGateState, WINDOWS_GUI_GATE_STATE_SCHEMA,
  type WindowsGuiGateState,
} from "./execution-gate-storage.js";
import { acquireInteractiveSessionLease } from "./interactive-session.js";

export interface ExecutionGuiGate {
  readonly id: string;
  release(): ResourceCleanupReceipt | Promise<ResourceCleanupReceipt>;
  /** Keep persistent quarantine; release only the ordinary process lease. */
  quarantine(reason: string): void | Promise<void>;
}

export interface WindowsExecutionGuiGateOptions {
  /** Trusted wrapper input read from the current Windows token. */
  readonly userSid: string;
  /** Trusted wrapper input read from the current Windows process session. */
  readonly sessionId: number;
  /** Trusted wrapper input; only the interactive default desktop is accepted. */
  readonly desktop: string;
  readonly timeoutMs?: number;
  readonly retryIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface WindowsExecutionGuiGateRecoveryProof {
  /** Exact opaque quarantine generation observed after the owned resources were cleaned up. */
  readonly quarantine: WindowsExecutionGuiGateQuarantineIdentity;
  readonly status: "ownedResourcesCleanupConfirmed";
  readonly proofId: string;
  readonly observedAt: string;
}

export interface WindowsExecutionGuiGateQuarantineIdentity {
  readonly scopeId: string;
  readonly leaseToken: string;
  readonly createdAt: string;
}

/** @internal Test-only OS/storage seam; absent from the public barrel. */
export interface WindowsExecutionGuiGateTestRuntime {
  readonly platform: "win32";
  readonly localAppData: string;
  readonly beforeRetireRename?: (state: WindowsGuiGateState) => void | Promise<void>;
}

interface GateLocation { readonly directory: string; readonly name: string; readonly id: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function acquireWindowsExecutionGuiGate(
  options: WindowsExecutionGuiGateOptions,
): Promise<ExecutionGuiGate> {
  if (process.platform !== "win32") throw new Error("Windows GUI gate requires Windows.");
  return acquire(options, productionRuntime());
}

/** @internal */
export function acquireWindowsExecutionGuiGateForTest(options: WindowsExecutionGuiGateOptions,
  runtime: WindowsExecutionGuiGateTestRuntime): Promise<ExecutionGuiGate> {
  return acquire(options, validateRuntime(runtime));
}

/**
 * Controlled operational recovery. The caller must first obtain real proof that
 * every resource owned by the abandoned execution has finished cleanup.
 */
export async function recoverWindowsExecutionGuiGateQuarantine(
  options: WindowsExecutionGuiGateOptions, proof: WindowsExecutionGuiGateRecoveryProof,
): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows GUI gate recovery requires Windows.");
  await recover(options, proof, productionRuntime());
}

/** Read the current quarantine generation for an operator-controlled cleanup workflow. */
export async function observeWindowsExecutionGuiGateQuarantine(
  options: WindowsExecutionGuiGateOptions,
): Promise<WindowsExecutionGuiGateQuarantineIdentity | null> {
  if (process.platform !== "win32") throw new Error("Windows GUI gate observation requires Windows.");
  return observe(options, productionRuntime());
}

/** @internal */
export function recoverWindowsExecutionGuiGateQuarantineForTest(options: WindowsExecutionGuiGateOptions,
  proof: WindowsExecutionGuiGateRecoveryProof, runtime: WindowsExecutionGuiGateTestRuntime): Promise<void> {
  return recover(options, proof, validateRuntime(runtime));
}

/** @internal */
export function observeWindowsExecutionGuiGateQuarantineForTest(options: WindowsExecutionGuiGateOptions,
  runtime: WindowsExecutionGuiGateTestRuntime): Promise<WindowsExecutionGuiGateQuarantineIdentity | null> {
  return observe(options, validateRuntime(runtime));
}

/** @internal */
export function windowsExecutionGuiGateLocationForTest(options: WindowsExecutionGuiGateOptions,
  runtime: WindowsExecutionGuiGateTestRuntime): GateLocation {
  return location(options, validateRuntime(runtime));
}

async function acquire(options: WindowsExecutionGuiGateOptions,
  runtime: WindowsExecutionGuiGateTestRuntime): Promise<ExecutionGuiGate> {
  const place = location(options, runtime);
  const lease = await acquireInteractiveSessionLease({ directory: place.directory, name: place.name,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.retryIntervalMs === undefined ? {} : { retryIntervalMs: options.retryIntervalMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }) });
  try {
    if (await readGateState(place.directory, place.name) !== null) {
      throw new Error(`Windows GUI gate ${place.id} is quarantined pending controlled recovery.`);
    }
    const state: WindowsGuiGateState = Object.freeze({
      schema: WINDOWS_GUI_GATE_STATE_SCHEMA, scopeId: place.id,
      leaseToken: lease.leaseToken, status: "taintedUntilCleanupConfirmed", createdAt: new Date().toISOString(),
    });
    await publishGateState(place.directory, place.name, state);
    let terminal: "active" | "released" | "quarantined" = "active";
    return Object.freeze({ id: place.id,
      release: async () => {
        if (terminal === "released") return Object.freeze({ status: "released" as const });
        if (terminal === "quarantined") return Object.freeze({ status: "unconfirmed" as const,
          reason: "Windows GUI gate remains quarantined." });
        const receipt = await lease.release();
        if (receipt.status !== "released") return receipt;
        await retireGateState(place.directory, place.name, state, "released", randomUUID(),
          runtime.beforeRetireRename === undefined ? {} : { beforeRename: runtime.beforeRetireRename });
        terminal = "released";
        return receipt;
      },
      quarantine: async (_reason: string) => {
        if (terminal !== "active") return;
        const receipt = await lease.release();
        if (receipt.status === "released") terminal = "quarantined";
      },
    });
  } catch (error) {
    await lease.release().catch(() => undefined);
    throw error;
  }
}

async function recover(options: WindowsExecutionGuiGateOptions, proof: WindowsExecutionGuiGateRecoveryProof,
  runtime: WindowsExecutionGuiGateTestRuntime): Promise<void> {
  const place = location(options, runtime);
  validateRecoveryProof(proof, place.id);
  const lease = await acquireInteractiveSessionLease({ directory: place.directory, name: place.name,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.retryIntervalMs === undefined ? {} : { retryIntervalMs: options.retryIntervalMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }) });
  let state: WindowsGuiGateState;
  try {
    const observed = await readGateState(place.directory, place.name);
    if (observed === null) throw new Error("Windows GUI gate has no quarantine to recover.");
    if (observed.scopeId !== place.id) throw new Error("Windows GUI gate quarantine scope changed.");
    if (observed.scopeId !== proof.quarantine.scopeId
        || observed.leaseToken !== proof.quarantine.leaseToken
        || observed.createdAt !== proof.quarantine.createdAt) {
      throw new Error("Windows GUI gate quarantine generation changed; recovery proof is stale.");
    }
    if (Date.parse(proof.observedAt) < Date.parse(observed.createdAt)) {
      throw new Error("Windows GUI gate cleanup proof predates the quarantine generation.");
    }
    state = observed;
  } catch (error) {
    await lease.release().catch(() => undefined);
    throw error;
  }
  const receipt = await lease.release();
  if (receipt.status !== "released") {
    throw new Error("Windows GUI gate recovery lease release was unconfirmed; quarantine remains.");
  }
  await retireGateState(place.directory, place.name, state, "recovered", proof.proofId,
    runtime.beforeRetireRename === undefined ? {} : { beforeRename: runtime.beforeRetireRename });
}

async function observe(options: WindowsExecutionGuiGateOptions,
  runtime: WindowsExecutionGuiGateTestRuntime): Promise<WindowsExecutionGuiGateQuarantineIdentity | null> {
  const place = location(options, runtime);
  const state = await readGateState(place.directory, place.name);
  if (state === null) return null;
  if (state.scopeId !== place.id) throw new Error("Windows GUI gate quarantine scope changed.");
  return Object.freeze({ scopeId: state.scopeId, leaseToken: state.leaseToken, createdAt: state.createdAt });
}

function location(options: WindowsExecutionGuiGateOptions,
  runtime: WindowsExecutionGuiGateTestRuntime): GateLocation {
  const localAppData = normalizedAbsolutePath(runtime.localAppData);
  const userSid = normalizedSid(options.userSid);
  if (!Number.isSafeInteger(options.sessionId) || options.sessionId < 0) {
    throw new Error("Windows GUI gate sessionId must be a non-negative integer.");
  }
  if (typeof options.desktop !== "string" || options.desktop.trim().toLowerCase() !== "default") {
    throw new Error("Windows GUI execution is supported only on the default desktop.");
  }
  const digest = createHash("sha256").update(`${userSid}\0${options.sessionId}\0default`, "utf8")
    .digest("hex").slice(0, 32);
  return Object.freeze({ directory: path.join(localAppData, "SurfaceLoom", "interactive-session"),
    name: `windows-gui-${digest}`, id: `windows-gui:${digest}` });
}

function productionRuntime(): WindowsExecutionGuiGateTestRuntime {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData === undefined) throw new Error("Windows GUI gate requires LOCALAPPDATA.");
  return validateRuntime({ platform: "win32", localAppData });
}

function validateRuntime(runtime: WindowsExecutionGuiGateTestRuntime): WindowsExecutionGuiGateTestRuntime {
  if (runtime.platform !== "win32") throw new Error("Windows GUI gate runtime must be win32.");
  if (runtime.beforeRetireRename !== undefined && typeof runtime.beforeRetireRename !== "function") {
    throw new Error("Windows GUI gate retirement seam must be a function.");
  }
  return Object.freeze({ platform: "win32", localAppData: normalizedAbsolutePath(runtime.localAppData),
    ...(runtime.beforeRetireRename === undefined ? {} : {
      beforeRetireRename: runtime.beforeRetireRename,
    }) });
}

function validateRecoveryProof(proof: WindowsExecutionGuiGateRecoveryProof, scopeId: string): void {
  const quarantine = typeof proof === "object" && proof !== null ? proof.quarantine : undefined;
  if (typeof proof !== "object" || proof === null || typeof quarantine !== "object" || quarantine === null
      || quarantine.scopeId !== scopeId
      || typeof quarantine.leaseToken !== "string" || !UUID.test(quarantine.leaseToken)
      || typeof quarantine.createdAt !== "string"
      || !isCanonicalTimestamp(quarantine.createdAt)
      || proof.status !== "ownedResourcesCleanupConfirmed"
      || typeof proof.proofId !== "string" || !UUID.test(proof.proofId)
      || typeof proof.observedAt !== "string" || !isCanonicalTimestamp(proof.observedAt)) {
    throw new Error("Windows GUI gate recovery requires canonical owned-resource cleanup proof.");
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function normalizedAbsolutePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
      || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error("Windows GUI gate LOCALAPPDATA must be a normalized absolute path.");
  }
  return value;
}

function normalizedSid(value: unknown): string {
  if (typeof value !== "string" || !/^S-1-(?:\d+-)+\d+$/iu.test(value)) {
    throw new Error("Windows GUI gate userSid is invalid.");
  }
  return value.toUpperCase();
}
