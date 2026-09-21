import { isDeepStrictEqual } from "node:util";

import {
  createOperationId, parseOperationId, parseRunId, parseTaskId, parseTestId,
  type OperationId, type RunId,
} from "./ids.js";
import { normalizeParameters } from "./parameter-normalization.js";
import { readSafeRecordEnvelope } from "./safe-data.js";
import type {
  PersistentRunService, PersistentWorkspaceLifecycle, StartRunResult,
} from "./persistent-service.js";
import type { StoredRunRecord } from "./stores/contracts.js";
import type { EffectLevel, ServicePlatform } from "./test-definition.js";
import type { TestCatalog } from "./catalog.js";
import type { PrepareOperationRecord } from "./workspaces/contracts.js";
import type { WorkspaceProvider, WorkspaceSnapshot, WorkspaceSource } from "./workspace.js";
import { exactKeys } from "./validation.js";

const sensitiveEffects = new Set<EffectLevel>(["externalEffect", "securitySensitive"]);
const supportedPlatforms = new Set<ServicePlatform>(["darwin", "linux", "win32"]);
const maxArtifactChunkBytes = 256 * 1024;

export interface ManagedWorkspaceProvider extends WorkspaceProvider, PersistentWorkspaceLifecycle {
  getOperation(operationId: string): Readonly<PrepareOperationRecord> | undefined;
}

export interface AgentTestServiceOptions {
  readonly catalog: TestCatalog;
  readonly runs: PersistentRunService;
  readonly workspaceProvider: ManagedWorkspaceProvider;
  /** Public keys mapped to private, preconfigured workspace sources. */
  readonly workspaceSources: Readonly<Record<string, WorkspaceSource>>;
  readonly platform?: ServicePlatform;
}

export interface StartTestRequest {
  readonly requestId: string;
  readonly snapshotId: string;
  readonly testId: string;
  readonly parameters?: unknown;
  readonly taskId?: string;
  readonly acknowledgedEffect?: EffectLevel;
}

export class AgentTestService {
  readonly #catalog: TestCatalog;
  readonly #runs: PersistentRunService;
  readonly #provider: ManagedWorkspaceProvider;
  readonly #sources: ReadonlyMap<string, Readonly<WorkspaceSource>>;
  readonly #platform: ServicePlatform;
  readonly #snapshots = new Map<string, WorkspaceSnapshot>();
  readonly #snapshotOwners = new Map<string, string>();
  readonly #preparations = new Map<OperationId, Promise<void>>();

  constructor(options: AgentTestServiceOptions) {
    this.#catalog = options.catalog;
    this.#runs = options.runs;
    this.#provider = options.workspaceProvider;
    this.#sources = snapshotSources(options.workspaceSources, this.#provider.id);
    const platform = options.platform ?? process.platform;
    if (!supportedPlatforms.has(platform as ServicePlatform)) {
      throw new TypeError(`Unsupported service platform ${platform}.`);
    }
    this.#platform = platform as ServicePlatform;
  }

  catalog() { return this.#catalog.list(); }

  prepare(sourceKey: string, revision: string): Readonly<{
    operationId: OperationId; status: "preparing";
  }> {
    const source = this.#sources.get(text(sourceKey, "sourceKey", 128));
    if (source === undefined) throw new TypeError(`Unknown workspace sourceKey ${sourceKey}.`);
    const requestedRevision = text(revision, "revision", 256);
    const operationId = createOperationId();
    const controller = new AbortController();
    const pending = this.#provider.prepare({ operationId, source, revision: requestedRevision },
      controller.signal).then((snapshot) => { this.#snapshots.set(snapshot.snapshotId, snapshot); })
      .finally(() => { this.#preparations.delete(operationId); });
    this.#preparations.set(operationId, pending);
    void pending.catch(() => undefined);
    return Object.freeze({ operationId, status: "preparing" });
  }

  operation(operationId: string): Readonly<PrepareOperationRecord> | undefined {
    return this.#provider.getOperation(parseOperationId(operationId));
  }

  run(runId: string): Promise<StoredRunRecord | undefined> {
    return this.#runs.get(parseRunId(runId));
  }

  runByRequestId(requestId: string): Promise<StoredRunRecord | undefined> {
    return this.#runs.getByRequestId(requestId);
  }

  async start(input: StartTestRequest): Promise<StartRunResult> {
    const request = snapshotStartRequest(input);
    const definition = this.#catalog.require(parseTestId(request.testId));
    const parameters = normalizeParameters(definition, request.parameters ?? {});
    const taskId = request.taskId === undefined ? undefined : parseTaskId(request.taskId);
    const existing = await this.#runs.getByRequestId(request.requestId);
    if (existing !== undefined) {
      assertSameIntent(existing, request.snapshotId, definition.testId, parameters, taskId);
      return Object.freeze({ runId: existing.runId, status: existing.status, reused: true });
    }
    const snapshotId = text(request.snapshotId, "snapshotId", 128);
    const snapshot = this.#snapshots.get(snapshotId);
    if (snapshot === undefined) throw new TypeError("Workspace snapshot is not ready in this service process.");
    if (definition.runtime.executorId !== this.#runs.executorId) {
      throw new TypeError(`No executor is registered for ${definition.runtime.executorId}.`);
    }
    if (!definition.requirements.platforms.includes(this.#platform)) {
      throw new TypeError(`Test ${definition.testId} does not support ${this.#platform}.`);
    }
    if (sensitiveEffects.has(definition.effect) && request.acknowledgedEffect !== definition.effect) {
      throw new TypeError(`Test ${definition.testId} requires acknowledgedEffect=${definition.effect}.`);
    }
    const owner = this.#snapshotOwners.get(snapshotId);
    if (owner !== undefined && owner !== request.requestId) {
      throw new TypeError("Workspace snapshot has already been submitted by another request.");
    }
    this.#snapshotOwners.set(snapshotId, request.requestId);
    try {
      return await this.#runs.start({ requestId: request.requestId,
        snapshot: { snapshotId: snapshot.snapshotId, resolvedRevision: snapshot.resolvedRevision },
        testId: definition.testId, parameters, definition, workspace: snapshot,
        ...(taskId === undefined ? {} : { taskId }) });
    } catch (error) {
      if (owner === undefined) this.#snapshotOwners.delete(snapshotId);
      throw error;
    }
  }

  result(runId: string): Promise<StoredRunRecord | undefined> { return this.run(runId); }

  cancel(runId: string, reason: string) {
    return this.#runs.cancel(parseRunId(runId), text(reason, "reason", 500));
  }

  async artifact(artifactId: string, offset = 0, limit = maxArtifactChunkBytes) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be non-negative.");
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maxArtifactChunkBytes) {
      throw new TypeError(`limit must be 1..${maxArtifactChunkBytes}.`);
    }
    const stored = await this.#runs.getArtifact(text(artifactId, "artifactId", 128));
    if (stored === undefined) return undefined;
    const end = Math.min(offset + limit, stored.data.byteLength);
    if (offset > stored.data.byteLength) throw new TypeError("offset exceeds artifact size.");
    return Object.freeze({ artifact: stored.artifact, offset, dataBase64:
      Buffer.from(stored.data.subarray(offset, end)).toString("base64"),
    nextOffset: end < stored.data.byteLength ? end : null });
  }
}

function snapshotSources(input: Readonly<Record<string, WorkspaceSource>>, providerId: string) {
  const result = new Map<string, Readonly<WorkspaceSource>>();
  for (const [key, candidate] of Object.entries(readSafeRecordEnvelope(input, "workspaceSources"))) {
    const safeKey = text(key, "workspace source key", 128);
    if (result.has(safeKey)) throw new TypeError(`Duplicate workspace source key ${safeKey}.`);
    const source = readSafeRecordEnvelope(candidate, `workspaceSources.${safeKey}`);
    exactKeys(source, `workspaceSources.${safeKey}`, ["provider", "locator"]);
    if (source.provider !== providerId) {
      throw new TypeError(`Workspace source ${safeKey} must use provider ${providerId}.`);
    }
    result.set(safeKey, Object.freeze({ provider: text(source.provider, "provider", 128),
      locator: text(source.locator, "locator", 1_024) }));
  }
  return result;
}

function assertSameIntent(record: StoredRunRecord, snapshotId: string, testId: string,
  parameters: object, taskId: string | undefined): void {
  if (record.snapshot.snapshotId !== snapshotId || record.testId !== testId
    || !isDeepStrictEqual(record.parameters, parameters)
    || record.taskId !== taskId) {
    throw new TypeError("requestId was already used for a different run request.");
  }
}

function snapshotStartRequest(input: StartTestRequest): StartTestRequest {
  const value = readSafeRecordEnvelope(input, "StartTestRequest");
  exactKeys(value, "StartTestRequest", ["requestId", "snapshotId", "testId"],
    ["parameters", "taskId", "acknowledgedEffect"]);
  const acknowledged = value.acknowledgedEffect;
  if (acknowledged !== undefined && !new Set<EffectLevel>([
    "readOnly", "reversible", "writesLocal", "externalEffect", "securitySensitive",
  ]).has(acknowledged as EffectLevel)) throw new TypeError("acknowledgedEffect is invalid.");
  return { requestId: text(value.requestId, "requestId", 256),
    snapshotId: text(value.snapshotId, "snapshotId", 128),
    testId: text(value.testId, "testId", 256),
    ...(value.parameters === undefined ? {} : { parameters: value.parameters }),
    ...(value.taskId === undefined ? {} : { taskId: text(value.taskId, "taskId", 128) }),
    ...(acknowledged === undefined ? {} : { acknowledgedEffect: acknowledged as EffectLevel }) };
}

function text(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes) throw new TypeError(`${label} is invalid.`);
  return value;
}
