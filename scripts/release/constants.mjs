export const planSchemaVersionV1 = "surfaceloom.release-plan/1";
export const planSchemaVersion = "surfaceloom.release-plan/2";
export const manifestSchemaVersionV1 = "surfaceloom.release-manifest/1";
export const manifestSchemaVersion = "surfaceloom.release-manifest/2";
export const scanSchemaVersion = "surfaceloom.release-scan/1";

export const releasePackageNamesV1 = Object.freeze([
  "@surfaceloom/core",
  "@surfaceloom/component-catalog",
  "@surfaceloom/reporter",
  "@surfaceloom/agent-loop",
  "@surfaceloom/native",
  "@surfaceloom/browser-playwright",
  "@surfaceloom/test",
]);

export const releasePackageNames = Object.freeze([
  "@surfaceloom/core",
  "@surfaceloom/component-catalog",
  "@surfaceloom/reporter",
  "@surfaceloom/agent-loop",
  "@surfaceloom/llm-judge",
  "@surfaceloom/service",
  "@surfaceloom/test",
  "@surfaceloom/native",
  "@surfaceloom/browser-playwright",
]);

export function releasePackageNamesForSchemaVersion(schemaVersion) {
  if (schemaVersion === planSchemaVersionV1 || schemaVersion === manifestSchemaVersionV1) {
    return releasePackageNamesV1;
  }
  if (schemaVersion === planSchemaVersion || schemaVersion === manifestSchemaVersion) {
    return releasePackageNames;
  }
  return undefined;
}

export const releasePipeline = Object.freeze([
  "build",
  "strip",
  "platform-sign-and-staple",
  "final-package",
  "digest",
  "sbom-scan-provenance",
  "manifest",
  "detached-manifest-signature",
]);

export const defaultScanLimits = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxDepth: 8,
});

export const artifactKinds = Object.freeze(["tgz", "zip", "exe", "app"]);
export const hostOperatingSystems = Object.freeze(["windows", "macos", "linux"]);
export const hostArchitectures = Object.freeze(["x64", "arm64", "universal"]);
export const strictSemverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/u;
