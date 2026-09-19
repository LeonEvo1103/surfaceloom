import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import path from "node:path";

export const WINDOWS_GUI_GATE_STATE_SCHEMA = "surfaceloom.windows-gui-gate-state/1";
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_SOURCE}$`, "u");
const ACTIVE = new RegExp(`^active-(${UUID_SOURCE})\\.json$`, "u");
const PENDING = new RegExp(`^\\.pending-${UUID_SOURCE}\\.json$`, "u");
const RETIRED = new RegExp(`^retired-(?:released|recovered)-${UUID_SOURCE}-${UUID_SOURCE}\\.json$`, "u");

export interface WindowsGuiGateState {
  readonly schema: typeof WINDOWS_GUI_GATE_STATE_SCHEMA;
  readonly scopeId: string;
  readonly leaseToken: string;
  readonly status: "taintedUntilCleanupConfirmed";
  readonly createdAt: string;
}

export interface GateStateRetireRuntime {
  /** Contract-test seam immediately before the generation-specific rename. */
  readonly beforeRename?: (state: WindowsGuiGateState) => void | Promise<void>;
}

export async function publishGateState(directory: string, name: string,
  state: WindowsGuiGateState): Promise<void> {
  const root = gateStatePath(directory, name);
  await ensureStateDirectory(root);
  if (await readGateState(directory, name) !== null) {
    throw new Error("Windows GUI gate scope is quarantined.");
  }
  const pending = path.join(root, `.pending-${state.leaseToken}.json`);
  const destination = activeStatePath(root, state.leaseToken);
  const handle = await open(pending, "wx", 0o600);
  try { await handle.writeFile(serialize(state), "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(pending, destination); }
  catch (error) {
    if (errorCode(error) === "EEXIST" || errorCode(error) === "ENOTEMPTY") {
      throw new Error("Windows GUI gate scope is quarantined.");
    }
    throw error;
  }
}

export async function readGateState(directory: string, name: string): Promise<WindowsGuiGateState | null> {
  const root = gateStatePath(directory, name);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rootInfo = await stateDirectoryInfo(root);
    if (rootInfo === null) return null;
    const entries = await readdir(root);
    const active = entries.filter((entry) => ACTIVE.test(entry));
    if (entries.some((entry) => !ACTIVE.test(entry) && !PENDING.test(entry) && !RETIRED.test(entry))) {
      throw new Error("Windows GUI gate quarantine directory contains an invalid entry.");
    }
    if (active.length > 1) throw new Error("Windows GUI gate has multiple active quarantine generations.");
    if (active.length === 0) return null;
    const match = ACTIVE.exec(active[0]!);
    if (match === null) throw new Error("Windows GUI gate quarantine filename is invalid.");
    let state: WindowsGuiGateState;
    try { state = await readStateFile(path.join(root, active[0]!), root, rootInfo); }
    catch (error) {
      // A valid release retires the active generation with an atomic rename. If
      // that happens after readdir, retry the complete identity-checked read.
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (state.leaseToken !== match[1]) {
      throw new Error("Windows GUI gate quarantine filename does not match its generation.");
    }
    return state;
  }
  throw new Error("Windows GUI gate quarantine generation changed repeatedly while reading.");
}

export async function retireGateState(directory: string, name: string, state: WindowsGuiGateState,
  proofKind: "released" | "recovered", proofId: string, runtime: GateStateRetireRuntime = {}): Promise<void> {
  const root = gateStatePath(directory, name);
  const rootInfo = await stateDirectoryInfo(root);
  if (rootInfo === null) throw new Error("Windows GUI gate quarantine ownership changed.");
  const source = activeStatePath(root, state.leaseToken);
  const existing = await readStateFile(source, root, rootInfo).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (existing === null || !sameState(existing, state)) {
    throw new Error("Windows GUI gate quarantine ownership changed.");
  }
  await runtime.beforeRename?.(state);
  const destination = path.join(root, `retired-${proofKind}-${proofId}-${state.leaseToken}.json`);
  try { await rename(source, destination); }
  catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "EEXIST") {
      throw new Error("Windows GUI gate quarantine ownership changed during retirement.");
    }
    throw error;
  }
  const proof = await readStateFile(destination, root, rootInfo);
  if (!sameState(proof, state)) throw new Error("Windows GUI gate retirement proof changed.");
}

export function gateStatePath(directory: string, name: string): string {
  return path.join(directory, `${name}.quarantine`);
}

function activeStatePath(root: string, leaseToken: string): string {
  return path.join(root, `active-${leaseToken}.json`);
}

async function ensureStateDirectory(root: string): Promise<void> {
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
  if (await stateDirectoryInfo(root) === null) throw new Error("Windows GUI gate quarantine directory is missing.");
}

async function stateDirectoryInfo(root: string) {
  let info;
  try { info = await lstat(root, { bigint: true }); }
  catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || info.ino === 0n) {
    throw new Error("Windows GUI gate quarantine path is not a real directory.");
  }
  return info;
}

async function readStateFile(file: string, root: string,
  rootInfo: NonNullable<Awaited<ReturnType<typeof stateDirectoryInfo>>>): Promise<WindowsGuiGateState> {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.ino === 0n) {
    throw new Error("Windows GUI gate quarantine metadata is not a regular file.");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(file, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    const current = await lstat(file, { bigint: true });
    if (!opened.isFile() || opened.ino === 0n || opened.dev !== before.dev || opened.ino !== before.ino
        || !current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev
        || current.ino !== opened.ino || opened.size < 2n || opened.size > 4_096n) {
      throw new Error("Windows GUI gate quarantine metadata identity changed.");
    }
    const state = parse(await handle.readFile("utf8"));
    const generation = await lstat(root, { bigint: true });
    if (!generation.isDirectory() || generation.isSymbolicLink()
        || generation.dev !== rootInfo.dev || generation.ino !== rootInfo.ino) {
      throw new Error("Windows GUI gate quarantine directory changed.");
    }
    return state;
  } finally { await handle.close(); }
}

function sameState(left: WindowsGuiGateState, right: WindowsGuiGateState): boolean {
  return left.schema === right.schema && left.scopeId === right.scopeId
    && left.leaseToken === right.leaseToken && left.status === right.status
    && left.createdAt === right.createdAt;
}
function serialize(state: WindowsGuiGateState): string { return `${JSON.stringify(state)}\n`; }
function parse(source: string): WindowsGuiGateState {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("Windows GUI gate quarantine JSON is invalid."); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid quarantine state.");
  const record = value as Record<string, unknown>;
  const keys = ["schema", "scopeId", "leaseToken", "status", "createdAt"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))
      || record.schema !== WINDOWS_GUI_GATE_STATE_SCHEMA
      || typeof record.scopeId !== "string" || !/^windows-gui:[0-9a-f]{32}$/u.test(record.scopeId)
      || typeof record.leaseToken !== "string" || !UUID.test(record.leaseToken)
      || record.status !== "taintedUntilCleanupConfirmed"
      || typeof record.createdAt !== "string" || new Date(record.createdAt).toISOString() !== record.createdAt) {
    throw new Error("Windows GUI gate quarantine fields are invalid.");
  }
  const state = record as unknown as WindowsGuiGateState;
  if (serialize(state) !== source) throw new Error("Windows GUI gate quarantine JSON is not canonical.");
  return Object.freeze(state);
}
function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code : undefined;
}
