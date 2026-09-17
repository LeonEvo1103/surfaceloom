import { safeArchivePath } from "./archive-path.mjs";
import { assertScanBindsPublishedBytes, scanArtifact } from "./artifact-scan.mjs";
import { artifactKinds, manifestSchemaVersion, scanSchemaVersion } from "./constants.mjs";
import { canonicalInventoryDigest, sameDigest } from "./digest.mjs";
import { assertPackageSnapshotMatches, validatePackageSet } from "./package-graph.mjs";
import {
  validateCompliance, validateProvenance, validateSboms, verifyAuxiliaryBytes,
  externalDependencyNames, externalDependencyRanges,
} from "./release-evidence.mjs";
import {
  validateBuild, validateInventory, validatePipeline, validateProtocols, validateSignature,
  validateTargets,
} from "./release-fields.mjs";
import {
  assertNoPendingOrSecrets, digest, fail, integer, list, oneOf, record, sameJson, string,
} from "./shape.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const manifestFields = [
  "schemaVersion", "releaseId", "packages", "packageBuildOrder", "targets", "protocols",
  "source", "artifacts", "sboms", "compliance", "provenance", "pipeline",
];

export function validateReleaseManifest(value, options) {
  assertNoPendingOrSecrets(value);
  const manifest = record(value, "release manifest", manifestFields);
  if (manifest.schemaVersion !== manifestSchemaVersion) fail("schemaVersion", "Unsupported ReleaseManifest schemaVersion.");
  string(manifest.releaseId, "releaseId", /^[a-z0-9][a-z0-9._-]{2,127}$/u);
  const packages = validatePackageSet(manifest.packages, { allowLocalDependencies: false });
  if (!sameJson(manifest.packageBuildOrder, packages.buildOrder)) {
    fail("buildOrder", "Manifest package build order does not match its dependency graph.");
  }
  const targets = validateTargets(manifest.targets);
  validateProtocols(manifest.protocols);
  const source = validateSource(manifest.source);
  validatePipeline(manifest.pipeline);
  const settings = record(options, "manifest validation options",
    ["artifactEvidence", "auxiliaryBytes", "plan"]);
  if (!(settings.artifactEvidence instanceof Map)) fail("evidenceMap", "Artifact evidence must be supplied as a Map.");
  const artifacts = validateArtifacts(manifest.artifacts, targets.ids, source, settings);
  const artifactTargets = new Set(artifacts.artifacts.map((item) => item.targetId));
  if (artifactTargets.size !== targets.ids.size
      || [...targets.ids].some((targetId) => !artifactTargets.has(targetId))) {
    fail("targetCoverage", "Every manifest target must have a final artifact.");
  }
  const context = {
    artifacts: artifacts.byId,
    artifactIds: new Set(artifacts.byId.keys()),
    packages: new Map(packages.packages.map((item) => [item.name, item])),
    packageNames: new Set(packages.packages.map((item) => item.name)),
    externalDependencies: externalDependencyNames(packages.packages),
    externalDependencyRanges: externalDependencyRanges(packages.packages),
    sbomDependencies: new Map(),
    auxiliaryBytes: settings.auxiliaryBytes,
  };
  validateSboms(manifest.sboms, context);
  validateCompliance(manifest.compliance, context);
  validateProvenance(manifest.provenance, context);
  if (settings.plan !== undefined) assertPlanMatch(manifest, settings.plan, artifacts.byId);
  return manifest;
}

export function validateReleaseManifestJson(text, options) {
  return validateReleaseManifest(parseStrictJson(text), options);
}

function validateSource(value) {
  const source = record(value, "source", [
    "repository", "revision", "snapshotDigest", "dirtyPolicy", "lockDigest", "build",
  ]);
  string(source.repository, "source.repository");
  string(source.revision, "source.revision", /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
  digest(source.snapshotDigest, "source.snapshotDigest");
  digest(source.lockDigest, "source.lockDigest");
  const dirty = record(source.dirtyPolicy, "source.dirtyPolicy", ["mode", "changesDigest"], ["mode"]);
  oneOf(dirty.mode, ["require-clean", "recorded-dirty"], "source.dirtyPolicy.mode");
  if (dirty.mode === "require-clean" && Object.hasOwn(dirty, "changesDigest")) {
    fail("dirtyPolicy", "A clean source cannot claim a changes digest.");
  }
  if (dirty.mode === "recorded-dirty") digest(dirty.changesDigest, "source.dirtyPolicy.changesDigest");
  validateBuild(source.build, "source.build");
  return source;
}

function validateArtifacts(value, targetIds, source, settings) {
  const artifacts = list(value, "artifacts", { min: 1 });
  const byId = new Map();
  const paths = new Set();
  for (const [index, value] of artifacts.entries()) {
    const label = `artifacts[${index}]`;
    const item = record(value, label, [
      "id", "targetId", "path", "kind", "byteLength", "digest", "inventory", "scan", "signature",
    ]);
    string(item.id, `${label}.id`);
    if (byId.has(item.id)) fail("duplicateArtifact", `Duplicate artifact ${item.id}.`);
    if (!targetIds.has(item.targetId)) fail("artifactTarget", `${label} references an unknown target.`);
    safeArchivePath(string(item.path, `${label}.path`));
    if (paths.has(item.path)) fail("duplicateArtifactPath", `Duplicate artifact path ${item.path}.`);
    paths.add(item.path);
    oneOf(item.kind, artifactKinds, `${label}.kind`);
    integer(item.byteLength, `${label}.byteLength`, { min: 1 });
    digest(item.digest, `${label}.digest`);
    if (sameDigest(item.digest, source.snapshotDigest) || sameDigest(item.digest, source.lockDigest)) {
      fail("sourceDigestMasquerade", `${label} uses a source/lock digest as an artifact digest.`);
    }
    validateInventory(item.inventory, `${label}.inventory`);
    validateScan(item.scan, item, label);
    validateSignature(item.signature, `${label}.signature`, { allowPlanned: false });
    const evidence = record(settings.artifactEvidence.get(item.id), `${label} evidence`, ["bytes", "receipt"]);
    assertScanBindsPublishedBytes(evidence.receipt, evidence.bytes);
    const fresh = scanArtifact(evidence.bytes, { kind: item.kind, path: item.path, limits: item.scan.limits });
    if (!sameJson(fresh, evidence.receipt)) fail("scanReceipt", `${label} scan receipt is not reproducible.`);
    assertArtifactReceipt(item, fresh, label);
    validateSignatureEvidence(item, settings.auxiliaryBytes, label);
    byId.set(item.id, item);
  }
  if (settings.artifactEvidence.size !== byId.size) fail("extraArtifact", "Artifact evidence contains undeclared output.");
  return { artifacts, byId };
}

function validateScan(value, artifact, label) {
  const scan = record(value, `${label}.scan`, [
    "schemaVersion", "artifactDigest", "complete", "limits", "entryCount",
    "totalUncompressedBytes", "maxDepth", "inventoryDigest",
  ]);
  if (scan.schemaVersion !== scanSchemaVersion || scan.complete !== true) fail("incompleteScan", `${label} scan is incomplete.`);
  if (!sameDigest(digest(scan.artifactDigest, `${label}.scan.artifactDigest`), artifact.digest)) {
    fail("scanDigest", `${label} scan is bound to different bytes.`);
  }
  integer(scan.entryCount, `${label}.scan.entryCount`, { min: 1 });
  integer(scan.totalUncompressedBytes, `${label}.scan.totalUncompressedBytes`, { min: 1 });
  integer(scan.maxDepth, `${label}.scan.maxDepth`);
  string(scan.inventoryDigest, `${label}.scan.inventoryDigest`, /^[a-f0-9]{64}$/u);
  if (scan.entryCount !== artifact.inventory.length
      || scan.inventoryDigest !== canonicalInventoryDigest(artifact.inventory)) {
    fail("scanInventory", `${label} scan does not bind its exact inventory.`);
  }
}

function assertArtifactReceipt(artifact, receipt, label) {
  const scan = { ...receipt };
  delete scan.inventory;
  delete scan.format;
  delete scan.byteLength;
  if (artifact.byteLength !== receipt.byteLength || !sameDigest(artifact.digest, receipt.artifactDigest)
      || !sameJson(artifact.inventory, receipt.inventory) || !sameJson(artifact.scan, scan)) {
    fail("artifactEvidence", `${label} does not match final scanned bytes.`);
  }
}

function validateSignatureEvidence(artifact, auxiliaryBytes, label) {
  if (artifact.signature.status === "unsigned") return;
  const evidence = artifact.signature.evidence;
  if (!sameDigest(evidence.subjectDigest, artifact.digest)) fail("signatureSubject", `${label} signature covers other bytes.`);
  verifyAuxiliaryBytes(evidence, auxiliaryBytes, `${label}.signature.evidence`);
}

function assertPlanMatch(manifest, plan, artifacts) {
  if (plan.releaseId !== manifest.releaseId) fail("planMismatch", "Plan and manifest releaseId differ.");
  assertPackageSnapshotMatches(manifest.packages, plan.packages);
  if (!sameJson(manifest.targets, plan.targets) || !sameJson(manifest.protocols, plan.protocols)) {
    fail("compatibilityMismatch", "Manifest host or protocol compatibility differs from the plan.");
  }
  const expected = new Map(plan.expectedArtifacts.map((item) => [item.id, item]));
  if (expected.size !== artifacts.size) fail("artifactPlanMismatch", "Manifest artifact set differs from the plan.");
  for (const [id, artifact] of artifacts) {
    const planned = expected.get(id);
    if (planned === undefined || planned.targetId !== artifact.targetId
        || planned.path !== artifact.path || planned.kind !== artifact.kind
        || !sameJson(planned.inventoryPaths, artifact.inventory.map((entry) => entry.path))) {
      fail("artifactPlanMismatch", `Artifact ${id} differs from its plan.`);
    }
  }
}
