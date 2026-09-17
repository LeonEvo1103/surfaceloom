import type { TestPlatform } from "@surfaceloom/core";
import { redactReportText, type SurfaceKind } from "@surfaceloom/reporter";

import {
  assertIssuedExecutionScope,
  identifier,
  sameExecutionScope,
  type ExecutionScope,
} from "./execution-scope.js";
import { jsonSnapshot } from "./json-data.js";

export type SurfaceOwnership = "owned" | "borrowed";
export type SurfaceCleanup =
  | { readonly status: "confirmed"; readonly resource: string }
  | { readonly status: "notRequired"; readonly resource: string }
  | { readonly status: "unconfirmed"; readonly resource: string; readonly reason: string };

export interface SurfaceAcquisitionInput {
  readonly scope: ExecutionScope;
  readonly surfaceId: string;
  readonly kind: SurfaceKind;
  readonly hostId: string;
  readonly executionPlatform: TestPlatform;
  readonly effectiveCapabilities: readonly string[];
  readonly ownership: SurfaceOwnership;
  readonly cleanup: SurfaceCleanup;
}

export interface SurfaceAcquisition extends SurfaceAcquisitionInput {
  readonly providerId: string;
}

export interface SurfaceAcquisitionProvider {
  readonly providerId: string;
  submit(input: SurfaceAcquisitionInput): SurfaceAcquisition;
}

export interface SealedSurfaceAcquisitions {
  readonly scope: ExecutionScope;
  readonly acquisitions: readonly SurfaceAcquisition[];
  readonly sealed: true;
}

const sealedSurfaceSnapshots = new WeakSet<object>();
const issuedSurfaceAcquisitions = new WeakSet<object>();

export function assertSealedSurfaceAcquisitions(value: SealedSurfaceAcquisitions): void {
  if (!sealedSurfaceSnapshots.has(value)) {
    throw new Error("Surface acquisitions were not sealed by the provider registry.");
  }
  for (const acquisition of value.acquisitions) {
    if (!issuedSurfaceAcquisitions.has(acquisition)) {
      throw new Error("Surface acquisition was not issued by its provider registry.");
    }
  }
}

/** Only a registry-issued provider handle can submit observed surface facts. */
export class SurfaceAcquisitionRegistry {
  readonly #scope: ExecutionScope;
  readonly #providerIds = new Set<string>();
  readonly #surfaces = new Map<string, SurfaceAcquisition>();
  #sealed = false;

  constructor(scope: ExecutionScope) {
    assertIssuedExecutionScope(scope);
    this.#scope = scope;
  }

  authorizeProvider(providerIdInput: string): SurfaceAcquisitionProvider {
    if (this.#sealed) throw new Error("Surface registry is sealed.");
    const providerId = identifier("providerId", providerIdInput);
    if (this.#providerIds.has(providerId)) throw new Error("Duplicate surface provider id.");
    this.#providerIds.add(providerId);
    return Object.freeze({
      providerId,
      submit: (input: SurfaceAcquisitionInput) => this.#submit(providerId, input),
    });
  }

  seal(): SealedSurfaceAcquisitions {
    if (this.#sealed) throw new Error("Surface registry is already sealed.");
    this.#sealed = true;
    const sealed = Object.freeze({ scope: this.#scope, acquisitions: this.snapshot(), sealed: true });
    sealedSurfaceSnapshots.add(sealed);
    return sealed;
  }

  snapshot(): readonly SurfaceAcquisition[] {
    return Object.freeze([...this.#surfaces.values()].sort((left, right) =>
      left.surfaceId.localeCompare(right.surfaceId)));
  }

  #submit(providerId: string, input: SurfaceAcquisitionInput): SurfaceAcquisition {
    if (this.#sealed) throw new Error("Late surface acquisition after seal.");
    jsonSnapshot(input, "surface acquisition");
    if (typeof input !== "object" || input === null || Object.keys(input).some((key) =>
      !["scope", "surfaceId", "kind", "hostId", "executionPlatform",
        "effectiveCapabilities", "ownership", "cleanup"].includes(key))) {
      throw new Error("Surface acquisition contains unknown metadata.");
    }
    if (!sameExecutionScope(this.#scope, input.scope)) {
      throw new Error("Surface acquisition crosses execution scopes.");
    }
    const surfaceId = identifier("surfaceId", input.surfaceId);
    if (this.#surfaces.has(surfaceId)) throw new Error("Duplicate surface id.");
    if (!["browser", "desktop", "system"].includes(input.kind)) {
      throw new Error("Unknown surface kind.");
    }
    const executionPlatform = platform(input.executionPlatform);
    if ((input.kind === "browser") !== (executionPlatform === "web")) {
      throw new Error("Surface kind and execution platform disagree.");
    }
    const effectiveCapabilities = normalizeCapabilities(input.effectiveCapabilities);
    const ownership = input.ownership;
    if (ownership !== "owned" && ownership !== "borrowed") {
      throw new Error("Unknown surface ownership.");
    }
    const cleanup = normalizeCleanup(input.cleanup);
    const acquisition = Object.freeze({
      scope: this.#scope,
      providerId,
      surfaceId,
      kind: input.kind,
      hostId: identifier("hostId", input.hostId),
      executionPlatform,
      effectiveCapabilities,
      ownership,
      cleanup,
    });
    issuedSurfaceAcquisitions.add(acquisition);
    this.#surfaces.set(surfaceId, acquisition);
    return acquisition;
  }
}

function normalizeCapabilities(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 1_000) {
    throw new Error("Surface capabilities must be a bounded array.");
  }
  const result = values.map((value) => identifier("effective capability", value)).sort();
  if (new Set(result).size !== result.length) throw new Error("Duplicate effective capability.");
  return Object.freeze(result);
}

function normalizeCleanup(value: SurfaceCleanup): SurfaceCleanup {
  const resource = identifier("cleanup resource", value.resource);
  if (value.status === "confirmed" || value.status === "notRequired") {
    if (Object.keys(value).some((key) => !["status", "resource"].includes(key))) {
      throw new Error("Surface cleanup contains unknown metadata.");
    }
    return Object.freeze({ status: value.status, resource });
  }
  if (value.status !== "unconfirmed"
      || Object.keys(value).some((key) => !["status", "resource", "reason"].includes(key))
      || typeof value.reason !== "string" || value.reason.length === 0) {
    throw new Error("Invalid surface cleanup receipt.");
  }
  return Object.freeze({ status: value.status, resource,
    reason: redactReportText(value.reason).slice(0, 500) });
}

function platform(value: TestPlatform): TestPlatform {
  if (!["macos", "windows", "web"].includes(value)) throw new Error("Unknown execution platform.");
  return value;
}
