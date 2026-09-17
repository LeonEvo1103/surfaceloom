import { artifactKinds, planSchemaVersion, releasePipeline } from "./constants.mjs";
import { localDependencyBlockers, packageDescriptor, validatePackageSet } from "./package-graph.mjs";
import {
  validateBuild, validatePipeline, validateProtocols, validateSignature, validateTargets,
} from "./release-fields.mjs";
import { fail, list, oneOf, record, string, uniqueStrings } from "./shape.mjs";
import { safeArchivePath } from "./archive-path.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const planFields = [
  "schemaVersion", "releaseId", "state", "packages", "packageBuildOrder", "readiness",
  "targets", "protocols", "source", "signingPolicy", "expectedArtifacts", "pipeline",
];

export function createReleasePlanFromPackageManifests(packageJsons, input) {
  const manifests = list(packageJsons, "package manifests", { min: 7 });
  const packages = manifests.map(packageDescriptor);
  const graph = validatePackageSet(packages, { allowLocalDependencies: true });
  const blockers = [];
  for (const manifest of manifests) {
    if (manifest.private === true) blockers.push(`${manifest.name}:private`);
  }
  blockers.push(...localDependencyBlockers(packages));
  const values = record(input, "release plan input", planFields.filter((field) =>
    !["schemaVersion", "packages", "packageBuildOrder", "readiness", "pipeline"].includes(field)));
  const plan = Object.freeze({
    schemaVersion: planSchemaVersion,
    ...values,
    packages: Object.freeze(packages),
    packageBuildOrder: graph.buildOrder,
    readiness: Object.freeze({ status: blockers.length === 0 ? "ready" : "pending",
      blockers: Object.freeze(blockers.sort()) }),
    pipeline: releasePipeline,
  });
  validateReleasePlan(plan);
  return plan;
}

export function validateReleasePlan(value) {
  const plan = record(value, "release plan", planFields);
  if (plan.schemaVersion !== planSchemaVersion) fail("schemaVersion", "Unsupported ReleasePlan schemaVersion.");
  string(plan.releaseId, "releaseId", /^[a-z0-9][a-z0-9._-]{2,127}$/u);
  oneOf(plan.state, ["pending", "ready"], "release plan state");
  const graph = validatePackageSet(plan.packages, { allowLocalDependencies: true });
  if (JSON.stringify(plan.packageBuildOrder) !== JSON.stringify(graph.buildOrder)) {
    fail("buildOrder", "Package build order does not match the dependency graph.");
  }
  const readiness = validateReadiness(plan.readiness);
  const dependencyBlockers = localDependencyBlockers(graph.packages);
  if (dependencyBlockers.some((blocker) => !readiness.blockers.includes(blocker))) {
    fail("readiness", "Plan readiness omits a local dependency blocker.");
  }
  if (plan.state !== plan.readiness.status) {
    fail("readiness", "Plan state must equal computed publication readiness.");
  }
  const targets = validateTargets(plan.targets);
  validateProtocols(plan.protocols);
  validatePlanSource(plan.source);
  validateSigningPolicy(plan.signingPolicy);
  const artifactTargets = validateExpectedArtifacts(plan.expectedArtifacts, targets.ids);
  if (artifactTargets.size !== targets.ids.size
      || [...targets.ids].some((targetId) => !artifactTargets.has(targetId))) {
    fail("targetCoverage", "Every planned target must have at least one expected artifact.");
  }
  validatePipeline(plan.pipeline);
  return plan;
}

export function validateReleasePlanJson(text) {
  return validateReleasePlan(parseStrictJson(text));
}

function validateReadiness(value) {
  const item = record(value, "readiness", ["status", "blockers"]);
  oneOf(item.status, ["pending", "ready"], "readiness.status");
  const blockers = uniqueStrings(item.blockers, "readiness.blockers");
  if ((item.status === "ready") !== (blockers.length === 0)) {
    fail("readiness", "Ready plans cannot have blockers and pending plans must have blockers.");
  }
  return { status: item.status, blockers };
}

function validatePlanSource(value) {
  const source = record(value, "source", [
    "repository", "revision", "snapshotDigest", "dirtyPolicy", "lockDigest", "build",
  ]);
  string(source.repository, "source.repository");
  fact(source.revision, "source.revision", (entry) =>
    string(entry, "source.revision.value", /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u));
  fact(source.snapshotDigest, "source.snapshotDigest", digestFact);
  oneOf(source.dirtyPolicy, ["require-clean", "record-dirty"], "source.dirtyPolicy");
  fact(source.lockDigest, "source.lockDigest", digestFact);
  validateBuild(source.build, "source.build");
}

function fact(value, label, validate) {
  const item = record(value, label, ["status", "value"], ["status"]);
  oneOf(item.status, ["pending", "resolved"], `${label}.status`);
  if (item.status === "pending" && Object.hasOwn(item, "value")) fail("pendingValue", `${label} pending fact has a value.`);
  if (item.status === "resolved") validate(item.value);
}

function digestFact(value) {
  const item = record(value, "digest fact", ["algorithm", "value"]);
  if (item.algorithm !== "sha256" || !/^[a-f0-9]{64}$/u.test(item.value) || /^0+$/u.test(item.value)) {
    fail("invalidDigest", "Resolved digest fact must be a non-zero SHA-256.");
  }
}

function validateSigningPolicy(value) {
  const item = record(value, "signingPolicy", ["artifacts", "manifest"]);
  const artifacts = record(item.artifacts, "signingPolicy.artifacts", ["status", "identityPolicy"]);
  if (artifacts.status !== "planned") fail("signingPolicy", "Artifact signing policy must be planned.");
  string(artifacts.identityPolicy, "signingPolicy.artifacts.identityPolicy");
  const manifest = record(item.manifest, "signingPolicy.manifest", ["status", "format", "identityPolicy"]);
  if (manifest.status !== "planned") fail("signingPolicy", "Detached manifest signing must be planned.");
  string(manifest.format, "signingPolicy.manifest.format");
  string(manifest.identityPolicy, "signingPolicy.manifest.identityPolicy");
}

function validateExpectedArtifacts(value, targetIds) {
  const artifacts = list(value, "expectedArtifacts", { min: 1 });
  const ids = new Set();
  const artifactTargets = new Set();
  for (const [index, value] of artifacts.entries()) {
    const label = `expectedArtifacts[${index}]`;
    const item = record(value, label, ["id", "targetId", "path", "kind", "inventoryPaths", "signature"]);
    string(item.id, `${label}.id`);
    if (ids.has(item.id)) fail("duplicateArtifact", `Duplicate expected artifact ${item.id}.`);
    ids.add(item.id);
    if (!targetIds.has(item.targetId)) fail("artifactTarget", `${label} references an unknown target.`);
    artifactTargets.add(item.targetId);
    safeArchivePath(string(item.path, `${label}.path`));
    oneOf(item.kind, artifactKinds, `${label}.kind`);
    uniqueStrings(item.inventoryPaths, `${label}.inventoryPaths`, { min: 1 }).forEach((path) => safeArchivePath(path));
    validateSignature(item.signature, `${label}.signature`, { allowPlanned: true });
  }
  return artifactTargets;
}
