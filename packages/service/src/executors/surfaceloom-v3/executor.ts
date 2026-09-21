import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { runCaseV3, RunCaseV3Error, type ResourceCleanupResult } from "@surfaceloom/test";

import type {
  CancelRequest, CancelResult, CleanupRequest, ExecuteRequest, Executor, RunResult,
} from "../../execution.js";
import { type RunId } from "../../ids.js";
import { fingerprintExecuteRequest } from "../../request-fingerprint.js";
import { snapshotCleanupRequest, snapshotCancelRequest,
  snapshotExecuteRequest, sameWorkspaceIdentity } from "../command/request-snapshot.js";
import { publishV3BundleArtifacts } from "./bundle-artifacts.js";
import { snapshotV3ExecutorConfig } from "./config.js";
import type {
  RegisteredSurfaceLoomV3Test, SurfaceLoomV3ExecutorOptions,
} from "./contracts.js";
import { bindV3Options } from "./options.js";
import { completedV3Result, failedV3Result, notStartedV3Result } from "./results.js";

interface RunEntry {
  readonly fingerprint: string;
  readonly abort: AbortController;
  readonly request: Readonly<ExecuteRequest>;
  readonly promise: Promise<RunResult>;
  terminal: boolean;
}

export class SurfaceLoomV3Executor implements Executor {
  readonly id: string;
  readonly #config: ReturnType<typeof snapshotV3ExecutorConfig>;
  readonly #runs = new Map<RunId, RunEntry>();

  constructor(id: string, options: SurfaceLoomV3ExecutorOptions) {
    if (id.length === 0) throw new TypeError("SurfaceLoom v3 executor id must not be empty.");
    this.id = id;
    this.#config = snapshotV3ExecutorConfig(options);
  }

  execute(input: ExecuteRequest, signal: AbortSignal): Promise<RunResult> {
    let request: Readonly<ExecuteRequest>;
    try { request = snapshotExecuteRequest(input); } catch (error) { return Promise.reject(error); }
    const fingerprint = fingerprintExecuteRequest(request);
    const existing = this.#runs.get(request.runId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new Error(`runId ${request.runId} was already used for another request.`));
      }
      return existing.promise;
    }
    const abort = new AbortController();
    const promise = this.#run(request, AbortSignal.any([signal, abort.signal]));
    const entry: RunEntry = { fingerprint, abort, request, promise, terminal: false };
    void promise.then(() => { entry.terminal = true; }, () => { entry.terminal = true; });
    this.#runs.set(request.runId, entry);
    return promise;
  }

  async cancel(input: CancelRequest, _signal: AbortSignal): Promise<CancelResult> {
    const request = snapshotCancelRequest(input);
    const entry = this.#runs.get(request.runId);
    if (entry === undefined) return { runId: request.runId, disposition: "not-found" };
    if (entry.terminal) return { runId: request.runId, disposition: "already-terminal" };
    entry.abort.abort(request.reason);
    return { runId: request.runId, disposition: "accepted" };
  }

  async cleanup(input: CleanupRequest, signal: AbortSignal) {
    const request = snapshotCleanupRequest(input);
    const entry = this.#runs.get(request.runId);
    if (entry === undefined) return { runId: request.runId, snapshotId: request.snapshot.snapshotId,
      status: "not-required" as const, tainted: false, attemptedAt: this.#timestamp() };
    if (!sameWorkspaceIdentity(entry.request.workspace, request.snapshot)) {
      return { runId: request.runId, snapshotId: request.snapshot.snapshotId,
        status: "unconfirmed" as const, tainted: true, attemptedAt: this.#timestamp(),
        detail: "Cleanup workspace identity does not match the registered v3 run." };
    }
    entry.abort.abort("Explicit SurfaceLoom v3 cleanup requested.");
    return await waitForCleanup(entry.promise, signal, request.runId, request.snapshot.snapshotId,
      () => this.#timestamp());
  }

  async #run(request: Readonly<ExecuteRequest>, signal: AbortSignal): Promise<RunResult> {
    const registration = this.#config.registrations.get(request.testId);
    const policyError = validateRegistration(request, registration, this.id);
    if (policyError !== undefined) {
      return notStartedV3Result(request, "v3_not_registered", policyError, this.#config.now);
    }
    if (pathsOverlap(this.#config.workRoot, request.workspace.rootPath)) {
      return notStartedV3Result(request, "v3_work_root_unsafe",
        "SurfaceLoom v3 workRoot must not overlap the immutable workspace.", this.#config.now);
    }
    const runRoot = path.join(this.#config.workRoot, request.runId.slice("run:".length));
    const stagingDirectory = path.join(runRoot, "staging");
    const outputDirectory = path.join(runRoot, "report");
    let cleanup: ResourceCleanupResult | undefined;
    let kernelStarted = false;
    let removeWork = true;
    let ownsRunRoot = false;
    try {
      await mkdir(this.#config.workRoot, { recursive: true, mode: 0o700 });
      await assertDisjointPhysicalRoots(this.#config.workRoot, request.workspace.rootPath);
      await mkdir(runRoot, { mode: 0o700 });
      ownsRunRoot = true;
      if (signal.aborted) throw signal.reason;
      const resolved = await registration!.resolve({ request, signal });
      if (resolved.definition.spec.id !== registration!.caseSpecId) {
        throw new Error("Resolved v3 Case does not match the registered CaseSpec.");
      }
      kernelStarted = true;
      const result = await runCaseV3(resolved.definition,
        bindV3Options(resolved, request, signal, stagingDirectory, outputDirectory));
      cleanup = result.cleanup;
      removeWork = cleanup.status === "passed" && !cleanup.tainted;
      if (result.bundle.report.run.id !== request.runId) {
        throw new Error("Reporter v3 run identity does not match the service runId.");
      }
      const artifacts = await publishV3BundleArtifacts(this.#config.artifactStore, request.runId,
        result.bundle.directory, { maxFiles: this.#config.maxBundleFiles,
          maxTotalBytes: this.#config.maxBundleBytes,
          maxArtifactBytes: this.#config.maxArtifactBytes });
      assertDeclaredArtifacts(request, artifacts);
      return completedV3Result(request, result.bundle.report, artifacts, cleanup,
        result.failureOrigin, signal.aborted, this.#config.now);
    } catch (error) {
      if (error instanceof RunCaseV3Error) cleanup = error.cleanup;
      removeWork = !kernelStarted || (cleanup?.status === "passed" && !cleanup.tainted);
      const artifacts = await this.#config.artifactStore.list(request.runId).catch(() => []);
      return failedV3Result(request, error, artifacts, cleanup, signal.aborted, this.#config.now);
    } finally {
      if (ownsRunRoot && removeWork) {
        await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  #timestamp(): string { return this.#config.now().toISOString(); }
}

function validateRegistration(request: Readonly<ExecuteRequest>,
  registration: RegisteredSurfaceLoomV3Test | undefined,
  executorId: string): string | undefined {
  if (request.definition.runtime.kind !== "surfaceloom-v3"
      || request.definition.runtime.executorId !== executorId || registration === undefined) {
    return "No exact registered SurfaceLoom v3 Case matches this test and executor.";
  }
  if (request.definition.caseSpecs.length !== 1
      || request.definition.caseSpecs[0]!.id !== registration.caseSpecId) {
    return "A SurfaceLoom v3 service test must reference its one registered CaseSpec.";
  }
  return undefined;
}

function assertDeclaredArtifacts(request: Readonly<ExecuteRequest>, artifacts: readonly {
  readonly name: string; readonly mediaType: string }[]): void {
  for (const expected of request.definition.output.artifacts.filter((item) => item.required)) {
    if (!artifacts.some((item) => item.name === expected.name
        && item.mediaType === expected.mediaType)) {
      throw new Error(`Required v3 artifact was not published: ${expected.name}`);
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(path.resolve(left), path.resolve(right));
  const reverse = path.relative(path.resolve(right), path.resolve(left));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..")
    || (!reverse.startsWith(`..${path.sep}`) && reverse !== "..");
}

async function assertDisjointPhysicalRoots(workRoot: string, workspaceRoot: string): Promise<void> {
  const descriptor = await lstat(workRoot);
  if (descriptor.isSymbolicLink() || !descriptor.isDirectory()) {
    throw new Error("SurfaceLoom v3 workRoot must be a real directory.");
  }
  const [canonicalWork, canonicalWorkspace] = await Promise.all([
    realpath(workRoot), realpath(workspaceRoot),
  ]);
  if (pathsOverlap(canonicalWork, canonicalWorkspace)) {
    throw new Error("SurfaceLoom v3 workRoot must not physically overlap the immutable workspace.");
  }
}

async function waitForCleanup(promise: Promise<RunResult>, signal: AbortSignal, runId: RunId,
  snapshotId: string, timestamp: () => string) {
  if (signal.aborted) return unconfirmed();
  let abortListener!: () => void;
  const aborted = new Promise<ReturnType<typeof unconfirmed>>(resolve => {
    abortListener = () => resolve(unconfirmed());
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try { return await Promise.race([promise.then((result) => result.cleanup), aborted]); }
  finally { signal.removeEventListener("abort", abortListener); }
  function unconfirmed() { return { runId, snapshotId, status: "unconfirmed" as const,
    tainted: true, attemptedAt: timestamp(), detail: "SurfaceLoom v3 cleanup did not settle." }; }
}
