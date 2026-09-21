import path from "node:path";
import { types } from "node:util";

import { parseTestId, type TestId } from "../../ids.js";
import { readSafeArrayEnvelope, readSafeRecordEnvelope } from "../../safe-data.js";
import type { ArtifactStore } from "../../stores/contracts.js";
import { exactKeys } from "../../validation.js";
import type {
  RegisteredSurfaceLoomV3Test, SurfaceLoomV3ExecutorOptions,
} from "./contracts.js";

const defaults = Object.freeze({ maxBundleFiles: 1_000,
  maxBundleBytes: 64 * 1024 * 1024, maxArtifactBytes: 32 * 1024 * 1024 });

export interface SurfaceLoomV3ExecutorConfig {
  readonly registrations: ReadonlyMap<TestId, RegisteredSurfaceLoomV3Test>;
  readonly workRoot: string;
  readonly artifactStore: ArtifactStore;
  readonly maxBundleFiles: number;
  readonly maxBundleBytes: number;
  readonly maxArtifactBytes: number;
  readonly now: () => Date;
}

export function snapshotV3ExecutorConfig(input: SurfaceLoomV3ExecutorOptions):
  SurfaceLoomV3ExecutorConfig {
  const value = readSafeRecordEnvelope(input, "SurfaceLoomV3ExecutorOptions");
  exactKeys(value, "SurfaceLoomV3ExecutorOptions", ["registrations", "workRoot", "artifactStore"],
    ["maxBundleFiles", "maxBundleBytes", "maxArtifactBytes", "now"]);
  if (typeof value.workRoot !== "string" || !path.isAbsolute(value.workRoot)) {
    throw new TypeError("SurfaceLoom v3 workRoot must be an absolute path.");
  }
  const registrations = new Map<TestId, RegisteredSurfaceLoomV3Test>();
  for (const inputRegistration of readSafeArrayEnvelope(value.registrations, "registrations")) {
    const item = readSafeRecordEnvelope(inputRegistration, "SurfaceLoom v3 registration");
    exactKeys(item, "SurfaceLoom v3 registration", ["testId", "caseSpecId", "resolve"]);
    const testId = parseTestId(item.testId);
    if (registrations.has(testId)) throw new TypeError(`Duplicate v3 registration for ${testId}.`);
    if (typeof item.caseSpecId !== "string" || item.caseSpecId.length === 0
        || Buffer.byteLength(item.caseSpecId, "utf8") > 256) {
      throw new TypeError("SurfaceLoom v3 caseSpecId is invalid.");
    }
    if (typeof item.resolve !== "function" || types.isProxy(item.resolve)) {
      throw new TypeError("SurfaceLoom v3 resolve must be a non-Proxy function.");
    }
    registrations.set(testId, Object.freeze({ testId, caseSpecId: item.caseSpecId,
      resolve: item.resolve as RegisteredSurfaceLoomV3Test["resolve"] }));
  }
  if (!isArtifactStore(value.artifactStore)) throw new TypeError("artifactStore is invalid.");
  const now = value.now ?? (() => new Date());
  if (typeof now !== "function" || types.isProxy(now)) throw new TypeError("now is invalid.");
  return Object.freeze({ registrations, workRoot: path.resolve(value.workRoot),
    artifactStore: value.artifactStore, maxBundleFiles: integer(value.maxBundleFiles,
      defaults.maxBundleFiles, "maxBundleFiles"), maxBundleBytes: integer(value.maxBundleBytes,
      defaults.maxBundleBytes, "maxBundleBytes"), maxArtifactBytes: integer(value.maxArtifactBytes,
      defaults.maxArtifactBytes, "maxArtifactBytes"), now: now as () => Date });
}

function isArtifactStore(value: unknown): value is ArtifactStore {
  return typeof value === "object" && value !== null && !types.isProxy(value)
    && typeof (value as ArtifactStore).put === "function"
    && typeof (value as ArtifactStore).get === "function"
    && typeof (value as ArtifactStore).list === "function";
}

function integer(value: unknown, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || (result as number) <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return result as number;
}
