import { types } from "node:util";
import path from "node:path";

import type { DesktopPlatform } from "@surfaceloom/core";
import type { EvidencePolicy, ReportEnvironment, ReportHostV3, ReportedApp } from "@surfaceloom/reporter";

import type { ExecuteCaseOptions } from "./contracts.js";
import type { ExecutionGuiGate } from "./execution-gate.js";
import { jsonSnapshot } from "./evidence/json-data.js";
import type { RequiredEvidenceRequirement } from "./evidence/required-policy.js";
import type {
  JudgeRunnerBindingV3,
} from "./judge/contracts.js";
import type { JudgeProvider, JudgeProviderContext, JudgeRequest } from "@surfaceloom/llm-judge";
import type {
  BrowserRunnerSurfaceV3,
  NativeRunnerSurfaceV3,
  RunCaseV3Identity,
  RunCaseV3Options,
  RunnerSurfaceV3,
} from "./runner-v3-contracts.js";
import type {
  BrowserSurfaceBackendPort,
  BrowserSurfaceRequirement,
  NativeSurfaceBackendPort,
  NativeSurfaceRequirement,
  PreparedNativeAcquisition,
  SurfaceBackendCall,
  SurfaceLease,
  SurfaceOwnership,
  SurfaceSetupContext,
} from "./surfaces/contracts.js";

/** Descriptor-only snapshot of every runner-controlled field before the first await. */
export function snapshotRunCaseV3Options(input: unknown): RunCaseV3Options {
  const value = record(input, "runner v3 options", ["platform", "runnerHostId", "run", "surfaces",
    "requiredEvidence", "judge", "evidencePolicy", "executionGate", "execution",
    "stagingDirectory", "outputDirectory"]);
  const requiredEvidenceValue = optional(value, "requiredEvidence", "runner v3 options");
  const judgeValue = optional(value, "judge", "runner v3 options");
  const evidencePolicyValue = optional(value, "evidencePolicy", "runner v3 options");
  const executionGateValue = optional(value, "executionGate", "runner v3 options");
  const surfaces = Object.freeze(items(required(value, "surfaces", "runner v3 options"),
    "runner v3 surfaces").map(snapshotSurface));
  const executionGate = executionGateValue === undefined ? undefined
    : snapshotExecutionGate(executionGateValue);
  if (executionGate !== undefined && surfaces.some((surface) =>
    surface.kind === "browser" && surface.lease !== undefined)) {
    throw new Error("runner v3 executionGate cannot be combined with per-surface leases.");
  }
  return Object.freeze({
    platform: required(value, "platform", "runner v3 options") as RunCaseV3Options["platform"],
    runnerHostId: required(value, "runnerHostId", "runner v3 options") as string,
    run: snapshotRun(required(value, "run", "runner v3 options")),
    surfaces,
    ...(requiredEvidenceValue === undefined ? {} : {
      requiredEvidence: Object.freeze(items(requiredEvidenceValue, "required evidence").map(
        (item, index) => exactJson<RequiredEvidenceRequirement>(item, `required evidence[${index}]`,
          ["artifactId", "requireComplete"]),
      )),
    }),
    ...(judgeValue === undefined ? {} : { judge: snapshotJudgeBinding(judgeValue) }),
    ...(evidencePolicyValue === undefined ? {} : {
      evidencePolicy: exactJson<Partial<EvidencePolicy>>(evidencePolicyValue, "evidence policy",
        ["screenshots", "video", "trace", "accessibilityTree", "logs"]),
    }),
    ...(executionGate === undefined ? {} : { executionGate }),
    execution: snapshotExecution(required(value, "execution", "runner v3 options")),
    stagingDirectory: absolutePath(required(value, "stagingDirectory", "runner v3 options"),
      "runner v3 stagingDirectory"),
    outputDirectory: absolutePath(required(value, "outputDirectory", "runner v3 options"),
      "runner v3 outputDirectory"),
  });
}

const abortSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function snapshotJudgeBinding(input: unknown): JudgeRunnerBindingV3 {
  const value = record(input, "runner v3 judge", ["provider", "deadlineAt", "signal"]);
  const deadlineAt = optional(value, "deadlineAt", "runner v3 judge");
  if (deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || (deadlineAt as number) < 0)) {
    throw new Error("runner v3 judge.deadlineAt must be an absolute epoch-millisecond integer.");
  }
  const signal = optional(value, "signal", "runner v3 judge");
  if (signal !== undefined && !genuineAbortSignal(signal)) {
    throw new Error("runner v3 judge.signal must be a genuine AbortSignal.");
  }
  return Object.freeze({ provider: snapshotJudgeProvider(required(value, "provider", "runner v3 judge")),
    ...(deadlineAt === undefined ? {} : { deadlineAt: deadlineAt as number }),
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }) });
}

function snapshotJudgeProvider(input: unknown): JudgeProvider {
  if (typeof input !== "object" || input === null || types.isProxy(input)) {
    throw new Error("runner v3 judge.provider must be a non-Proxy object.");
  }
  const nameDescriptor = Object.getOwnPropertyDescriptor(input, "name");
  if (nameDescriptor === undefined || !("value" in nameDescriptor)
      || typeof nameDescriptor.value !== "string") {
    throw new Error("runner v3 judge.provider.name must be an own data string.");
  }
  let owner: object | null = input;
  let judge: unknown;
  for (let depth = 0; owner !== null && depth < 3; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, "judge");
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) throw new Error("runner v3 judge.provider.judge must not be an accessor.");
      judge = descriptor.value;
      break;
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  if (typeof judge !== "function") throw new Error("runner v3 judge.provider.judge must be a function.");
  return Object.freeze({ name: nameDescriptor.value,
    judge: (request: JudgeRequest, context: JudgeProviderContext) =>
      Reflect.apply(judge as Function, input, [request, context]) as Promise<unknown> });
}

function genuineAbortSignal(input: unknown): boolean {
  if (typeof input !== "object" || input === null || types.isProxy(input)
      || abortSignalAborted === undefined) return false;
  try { abortSignalAborted.call(input); return true; } catch { return false; }
}

/** Capture an already-acquired gate before validating unrelated runner fields. */
export function snapshotRunCaseV3ExecutionGate(input: unknown): ExecutionGuiGate | undefined {
  if (typeof input !== "object" || input === null || types.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(input, "executionGate");
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new Error("runner v3 options.executionGate must be an enumerable data field.");
  }
  return descriptor.value === undefined ? undefined : snapshotExecutionGate(descriptor.value);
}

function snapshotExecutionGate(input: unknown): ExecutionGuiGate {
  const fields = record(input, "runner v3 executionGate", ["id", "release", "quarantine"]);
  const release = required(fields, "release", "runner v3 executionGate");
  if (typeof release !== "function") throw new Error("runner v3 executionGate.release must be a function.");
  const quarantine = required(fields, "quarantine", "runner v3 executionGate");
  if (typeof quarantine !== "function") {
    throw new Error("runner v3 executionGate.quarantine must be a function.");
  }
  const id = required(fields, "id", "runner v3 executionGate");
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) {
    throw new Error("runner v3 executionGate.id must be a stable identifier.");
  }
  return Object.freeze({ id, release: () => Reflect.apply(release, input, []),
    quarantine: (reason: string) => Reflect.apply(quarantine, input, [reason]) });
}

function snapshotRun(input: unknown): RunCaseV3Identity {
  const value = record(input, "runner v3 run", ["id", "title", "app", "environment", "hosts"]);
  const environment = optional(value, "environment", "runner v3 run");
  return Object.freeze({
    id: required(value, "id", "runner v3 run") as string,
    title: required(value, "title", "runner v3 run") as string,
    app: exactJson<ReportedApp>(required(value, "app", "runner v3 run"), "runner v3 app",
      ["id", "name", "version", "build"]),
    ...(environment === undefined ? {} : {
      environment: exactJson<ReportEnvironment>(environment, "runner v3 environment",
        ["osName", "osVersion", "runnerName", "runnerVersion", "commit", "branch", "ci"]),
    }),
    hosts: Object.freeze(items(required(value, "hosts", "runner v3 run"), "runner v3 hosts")
      .map((host, index) => exactJson<ReportHostV3>(host, `runner v3 hosts[${index}]`,
        ["id", "os", "name", "osVersion", "architecture"]))),
  });
}

function snapshotExecution(input: unknown): Omit<ExecuteCaseOptions, "platform"> {
  const value = record(input, "runner v3 execution", ["plan", "environment", "policy", "timeoutMs",
    "cancellationGraceMs", "signal", "clock", "cleanupTimeoutMs"]);
  const result: Record<string, unknown> = {};
  for (const name of ["plan", "timeoutMs", "cancellationGraceMs", "signal", "clock",
    "cleanupTimeoutMs"] as const) {
    const item = optional(value, name, "runner v3 execution");
    if (item !== undefined) result[name] = item;
  }
  const environment = optional(value, "environment", "runner v3 execution");
  const policy = optional(value, "policy", "runner v3 execution");
  if (environment !== undefined) result.environment = jsonSnapshot(environment, "execution environment");
  if (policy !== undefined) result.policy = jsonSnapshot(policy, "execution policy");
  return Object.freeze(result) as Omit<ExecuteCaseOptions, "platform">;
}

function snapshotSurface(input: unknown, index: number): RunnerSurfaceV3 {
  const value = record(input, `runner v3 surfaces[${index}]`, ["kind", "requirement", "backend", "lease"]);
  const kind = required(value, "kind", `runner v3 surfaces[${index}]`);
  if (kind === "browser") return snapshotBrowser(value, index);
  if (kind === "native") return snapshotNative(value, index);
  throw new Error(`runner v3 surfaces[${index}].kind is invalid.`);
}

function snapshotBrowser(value: Descriptors, index: number): BrowserRunnerSurfaceV3 {
  const label = `runner v3 surfaces[${index}]`;
  const backendInput = required(value, "backend", label);
  const backendFields = record(backendInput, `${label}.backend`, ["hostId", "capabilities", "launch"]);
  const launch = required(backendFields, "launch", `${label}.backend`);
  if (typeof launch !== "function") throw new Error(`${label}.backend.launch must be a function.`);
  const backend: BrowserSurfaceBackendPort = Object.freeze({
    hostId: required(backendFields, "hostId", `${label}.backend`) as string,
    capabilities: stringArray(required(backendFields, "capabilities", `${label}.backend`),
      `${label}.backend.capabilities`),
    launch: (requirement: BrowserSurfaceRequirement, call: SurfaceBackendCall) =>
      Reflect.apply(launch, backendInput, [requirement, call]),
  });
  const leaseInput = optional(value, "lease", label);
  return Object.freeze({ kind: "browser",
    requirement: exactJson<BrowserSurfaceRequirement>(required(value, "requirement", label),
      `${label}.requirement`, ["kind", "surfaceId", "expectedHostId", "capabilities", "engine",
        "headless", "timeoutMs"]),
    backend,
    ...(leaseInput === undefined ? {} : { lease: snapshotLease(leaseInput, `${label}.lease`) }),
  });
}

function snapshotNative(value: Descriptors, index: number): NativeRunnerSurfaceV3 {
  const label = `runner v3 surfaces[${index}]`;
  if (optional(value, "lease", label) !== undefined) throw new Error(`${label}.lease is browser-only.`);
  const backendInput = required(value, "backend", label);
  const backendFields = record(backendInput, `${label}.backend`,
    ["hostId", "platform", "backend", "capabilities", "prepare"]);
  const prepare = required(backendFields, "prepare", `${label}.backend`);
  if (typeof prepare !== "function") throw new Error(`${label}.backend.prepare must be a function.`);
  const backend: NativeSurfaceBackendPort<"macos" | "windows"> = Object.freeze({
    hostId: required(backendFields, "hostId", `${label}.backend`) as string,
    platform: required(backendFields, "platform", `${label}.backend`) as "macos" | "windows",
    backend: required(backendFields, "backend", `${label}.backend`) as "ax" | "uia",
    capabilities: stringArray(required(backendFields, "capabilities", `${label}.backend`),
      `${label}.backend.capabilities`),
    prepare: <O extends SurfaceOwnership>(
      requirement: NativeSurfaceRequirement<DesktopPlatform, O>, context: SurfaceSetupContext,
    ) => Reflect.apply(prepare, backendInput, [requirement, context]) as
      PreparedNativeAcquisition<DesktopPlatform, O>,
  });
  return Object.freeze({ kind: "native",
    requirement: exactJson<NativeSurfaceRequirement<"macos" | "windows", SurfaceOwnership>>(
      required(value, "requirement", label), `${label}.requirement`, ["kind", "surfaceId",
        "expectedHostId", "platform", "backend", "acquisition", "capabilities", "target", "timeoutMs"]),
    backend,
  });
}

function snapshotLease(input: unknown, label: string): SurfaceLease {
  const value = record(input, label, ["id", "release"]);
  const release = required(value, "release", label);
  if (typeof release !== "function") throw new Error(`${label}.release must be a function.`);
  return Object.freeze({ id: required(value, "id", label) as string,
    release: () => Reflect.apply(release, input, []) });
}

function stringArray(input: unknown, label: string): readonly string[] {
  const values = items(input, label);
  if (values.some((value) => typeof value !== "string")) throw new Error(`${label} must contain strings.`);
  return Object.freeze(values as string[]);
}

type Descriptors = Record<PropertyKey, PropertyDescriptor>;

function record(input: unknown, label: string, allowed: readonly string[]): Descriptors {
  if (typeof input !== "object" || input === null || types.isProxy(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new Error(`${label} must be a plain data object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new Error(`${label} contains unknown metadata.`);
  }
  return descriptors;
}

function required(input: Descriptors, name: string, label: string): unknown {
  const value = optional(input, name, label);
  if (value === undefined) throw new Error(`${label}.${name} is required.`);
  return value;
}

function optional(input: Descriptors, name: string, label: string): unknown {
  const descriptor = input[name];
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new Error(`${label}.${name} must be an enumerable data field.`);
  }
  return descriptor.value;
}

function items(input: unknown, label: string): unknown[] {
  if (typeof input !== "object" || input === null || types.isProxy(input) || !Array.isArray(input)
      || Object.getPrototypeOf(input) !== Array.prototype) throw new Error(`${label} must be a plain array.`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const length = Object.getOwnPropertyDescriptor(input, "length");
  if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value)
      || (length.value as number) > 10_000) throw new Error(`${label} is not a bounded array.`);
  const size = length.value as number;
  const allowed = new Set(["length", ...Array.from({ length: size }, (_unused, index) => String(index))]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new Error(`${label} contains custom fields.`);
  }
  return Array.from({ length: size }, (_unused, index) => {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label}[${index}] is a hole or accessor.`);
    }
    return descriptor.value;
  });
}

function exactJson<T>(input: unknown, label: string, allowed: readonly string[]): T {
  record(input, label, allowed);
  return jsonSnapshot(input, label) as T;
}

function absolutePath(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0) throw new Error(`${label} must be a path.`);
  return path.resolve(input);
}
