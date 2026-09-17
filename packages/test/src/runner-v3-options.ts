import { types } from "node:util";
import path from "node:path";

import type { DesktopPlatform } from "@surfaceloom/core";
import type { EvidencePolicy, ReportEnvironment, ReportHostV3, ReportedApp } from "@surfaceloom/reporter";

import type { ExecuteCaseOptions } from "./contracts.js";
import { jsonSnapshot } from "./evidence/json-data.js";
import type { RequiredEvidenceRequirement } from "./evidence/required-policy.js";
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
    "requiredEvidence", "evidencePolicy", "execution", "stagingDirectory", "outputDirectory"]);
  const requiredEvidenceValue = optional(value, "requiredEvidence", "runner v3 options");
  const evidencePolicyValue = optional(value, "evidencePolicy", "runner v3 options");
  return Object.freeze({
    platform: required(value, "platform", "runner v3 options") as RunCaseV3Options["platform"],
    runnerHostId: required(value, "runnerHostId", "runner v3 options") as string,
    run: snapshotRun(required(value, "run", "runner v3 options")),
    surfaces: Object.freeze(items(required(value, "surfaces", "runner v3 options"),
      "runner v3 surfaces").map(snapshotSurface)),
    ...(requiredEvidenceValue === undefined ? {} : {
      requiredEvidence: Object.freeze(items(requiredEvidenceValue, "required evidence").map(
        (item, index) => exactJson<RequiredEvidenceRequirement>(item, `required evidence[${index}]`,
          ["artifactId", "requireComplete"]),
      )),
    }),
    ...(evidencePolicyValue === undefined ? {} : {
      evidencePolicy: exactJson<Partial<EvidencePolicy>>(evidencePolicyValue, "evidence policy",
        ["screenshots", "video", "trace", "accessibilityTree", "logs"]),
    }),
    execution: snapshotExecution(required(value, "execution", "runner v3 options")),
    stagingDirectory: absolutePath(required(value, "stagingDirectory", "runner v3 options"),
      "runner v3 stagingDirectory"),
    outputDirectory: absolutePath(required(value, "outputDirectory", "runner v3 options"),
      "runner v3 outputDirectory"),
  });
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
