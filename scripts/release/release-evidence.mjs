import { safeArchivePath } from "./archive-path.mjs";
import { digestRecord, sameDigest } from "./digest.mjs";
import { validateAuxiliary } from "./release-fields.mjs";
import { fail, list, record, string, uniqueStrings } from "./shape.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import { validateLicenseEvidence } from "./license-evidence.mjs";
import { strictSemverPattern } from "./constants.mjs";
import { satisfiesDependencyRange } from "./dependency-range.mjs";

export function validateSboms(value, context) {
  const sboms = list(value, "sboms", { min: 1 });
  const coveredArtifacts = new Set();
  const coveredPackages = new Set();
  for (const [index, value] of sboms.entries()) {
    const label = `sboms[${index}]`;
    const item = record(value, label, ["id", "schema", "path", "byteLength", "digest", "coverage"]);
    string(item.id, `${label}.id`);
    const schema = record(item.schema, `${label}.schema`, ["name", "version"]);
    if (schema.name !== "CycloneDX" || schema.version !== "1.6") {
      fail("sbomSchema", `${label} has unsupported schema/version.`);
    }
    validateAuxiliary({ path: item.path, byteLength: item.byteLength, digest: item.digest }, label);
    const bytes = verifyAuxiliaryBytes(item, context.auxiliaryBytes, label);
    const coverage = record(item.coverage, `${label}.coverage`, ["artifactIds", "packageNames"]);
    for (const id of uniqueStrings(coverage.artifactIds, `${label}.coverage.artifactIds`, { min: 1 })) {
      if (!context.artifactIds.has(id)) fail("sbomCoverage", `${label} covers unknown artifact ${id}.`);
      coveredArtifacts.add(id);
    }
    for (const name of uniqueStrings(coverage.packageNames, `${label}.coverage.packageNames`, { min: 1 })) {
      if (!context.packageNames.has(name)) fail("sbomCoverage", `${label} covers unknown package ${name}.`);
      coveredPackages.add(name);
    }
    validateSbomDocument(bytes, schema, coverage, context, label);
  }
  requireExactSet(coveredArtifacts, context.artifactIds, "SBOM artifact coverage");
  requireExactSet(coveredPackages, context.packageNames, "SBOM package coverage");
}

export function validateCompliance(value, context) {
  const item = record(value, "compliance", ["licenseFiles", "noticeFiles", "thirdParty"]);
  const evidenceBytes = { licenseFiles: [], noticeFiles: [] };
  for (const field of ["licenseFiles", "noticeFiles"]) {
    const files = list(item[field], `compliance.${field}`, { min: 1 });
    for (const [index, file] of files.entries()) {
      validateAuxiliary(file, `compliance.${field}[${index}]`);
      evidenceBytes[field].push(verifyAuxiliaryBytes(
        file, context.auxiliaryBytes, `compliance.${field}[${index}]`));
    }
  }
  const thirdParty = record(item.thirdParty, "compliance.thirdParty", [
    "status", "coveredPackageNames", "coveredDependencyNames",
  ]);
  if (thirdParty.status !== "complete") fail("thirdPartyCoverage", "Third-party compliance must be complete.");
  const packageCoverage = new Set(uniqueStrings(thirdParty.coveredPackageNames,
    "compliance.thirdParty.coveredPackageNames", { min: 1 }));
  const dependencyCoverage = new Set(uniqueStrings(thirdParty.coveredDependencyNames,
    "compliance.thirdParty.coveredDependencyNames"));
  requireExactSet(packageCoverage, context.packageNames, "third-party package coverage");
  requireExactSet(dependencyCoverage, context.externalDependencies, "third-party dependency coverage");
  validateLicenseEvidence(evidenceBytes.licenseFiles, evidenceBytes.noticeFiles, context);
}

export function validateProvenance(value, context) {
  const entries = list(value, "provenance", { min: 1 });
  const covered = new Set();
  for (const [index, value] of entries.entries()) {
    const label = `provenance[${index}]`;
    const item = record(value, label, [
      "id", "path", "byteLength", "digest", "artifactId", "subject",
    ]);
    string(item.id, `${label}.id`);
    validateAuxiliary({ path: item.path, byteLength: item.byteLength, digest: item.digest }, label);
    const bytes = verifyAuxiliaryBytes(item, context.auxiliaryBytes, label);
    const artifact = context.artifacts.get(item.artifactId);
    if (artifact === undefined || covered.has(item.artifactId)) {
      fail("provenanceCoverage", `${label} has an unknown or duplicate artifact subject.`);
    }
    const subject = record(item.subject, `${label}.subject`, ["name", "digest"]);
    if (subject.name !== artifact.path || !sameDigest(subject.digest, artifact.digest)) {
      fail("provenanceSubject", `${label} subject must bind the same artifact path and digest.`);
    }
    validateProvenanceDocument(bytes, subject, label);
    covered.add(item.artifactId);
  }
  requireExactSet(covered, context.artifactIds, "provenance artifact coverage");
}

export function verifyAuxiliaryBytes(item, auxiliaryBytes, label) {
  if (!(auxiliaryBytes instanceof Map)) fail("evidenceMap", "Auxiliary evidence must be supplied as a Map.");
  const bytes = auxiliaryBytes.get(item.path);
  if (bytes === undefined) fail("missingEvidence", `${label} bytes are missing.`);
  const actual = Buffer.from(bytes);
  if (actual.length !== item.byteLength || !sameDigest(digestRecord(actual), item.digest)) {
    fail("evidenceDigest", `${label} bytes do not match their final digest.`);
  }
  return actual;
}

export function externalDependencyNames(packages) {
  return new Set(externalDependencyRanges(packages).keys());
}

export function externalDependencyRanges(packages) {
  const packageNames = new Set(packages.map((item) => item.name));
  const result = new Map();
  for (const item of packages) {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, range] of Object.entries(item[field])) {
        if (packageNames.has(name)) continue;
        const ranges = result.get(name) ?? [];
        if (!ranges.includes(range)) ranges.push(range);
        result.set(name, ranges);
      }
    }
  }
  return result;
}

function requireExactSet(actual, expected, label) {
  if (actual.size !== expected.size || [...expected].some((entry) => !actual.has(entry))) {
    fail("coverage", `${label} is incomplete or contains extras.`);
  }
}

function validateSbomDocument(bytes, schema, coverage, context, label) {
  let document;
  try { document = parseStrictJson(bytes.toString("utf8")); }
  catch { fail("sbomDocument", `${label} is not strict JSON.`); }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    fail("sbomDocument", `${label} must be a JSON object.`);
  }
  if (schema.name === "CycloneDX"
      && (document.bomFormat !== "CycloneDX" || document.specVersion !== schema.version)) {
    fail("sbomDocument", `${label} bytes do not match declared CycloneDX schema.`);
  }
  if (!Array.isArray(document.components) || document.components.length === 0) {
    fail("sbomComponents", `${label} must contain derived components.`);
  }
  const components = new Map();
  for (const [index, value] of document.components.entries()) {
    const component = record(value, `${label}.components[${index}]`,
      ["type", "name", "version", "hashes", "licenses"], ["type", "name"]);
    string(component.type, `${label}.components[${index}].type`);
    string(component.name, `${label}.components[${index}].name`);
    const key = `${component.type}:${component.name}`;
    if (components.has(key)) fail("sbomComponents", `${label} duplicates component ${key}.`);
    components.set(key, component);
  }
  for (const packageName of coverage.packageNames) {
    const expected = context.packages.get(packageName);
    const component = components.get(`library:${packageName}`);
    if (component?.version !== expected.version || !hasLicense(component, expected.license)) {
      fail("sbomComponents", `${label} omits exact package component ${packageName}.`);
    }
  }
  const coveredDependencies = new Set();
  for (const packageName of coverage.packageNames) {
    const item = context.packages.get(packageName);
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(item[field])) if (!context.packageNames.has(name)) coveredDependencies.add(name);
    }
  }
  for (const name of coveredDependencies) {
    const component = components.get(`library:${name}`);
    const license = component === undefined ? undefined : componentLicense(component);
    if (component === undefined || license === undefined
        || typeof component.version !== "string"
        || !strictSemverPattern.test(component.version)) {
      fail("sbomComponents", `${label} omits licensed third-party component ${name}.`);
    }
    const ranges = context.externalDependencyRanges.get(name) ?? [];
    if (ranges.length === 0
        || ranges.some((range) => !satisfiesDependencyRange(component.version, range))) {
      fail("sbomComponents", `${label} resolves ${name} outside its declared dependency range.`);
    }
    const prior = context.sbomDependencies.get(name);
    const fact = { version: component.version, license };
    if (prior !== undefined && (prior.version !== fact.version || prior.license !== fact.license)) {
      fail("sbomComponents", `${label} conflicts on third-party component ${name}.`);
    }
    context.sbomDependencies.set(name, fact);
  }
  for (const artifactId of coverage.artifactIds) {
    const artifact = context.artifacts.get(artifactId);
    requireComponentHash(components.get(`file:${artifact.path}`), artifact.digest, label, artifact.path);
    for (const entry of artifact.inventory) {
      const name = `${artifact.path}!/${entry.path}`;
      requireComponentHash(components.get(`file:${name}`), entry.digest, label, name);
    }
  }
}

function requireComponentHash(component, expected, label, name) {
  if (component === undefined || !Array.isArray(component.hashes)
      || !component.hashes.some((hash) => hash?.alg === "SHA-256" && hash?.content === expected.value)) {
    fail("sbomComponents", `${label} omits content-derived component ${name}.`);
  }
}

function hasLicense(component, expected) {
  return Array.isArray(component.licenses)
    && component.licenses.some((entry) => entry?.license?.id === expected);
}

function componentLicense(component) {
  const ids = Array.isArray(component.licenses)
    ? component.licenses.map((entry) => entry?.license?.id)
      .filter((entry) => typeof entry === "string" && entry.length > 0) : [];
  return ids.length === 1 ? ids[0] : undefined;
}

function validateProvenanceDocument(bytes, subject, label) {
  let document;
  try { document = parseStrictJson(bytes.toString("utf8")); }
  catch { fail("provenanceDocument", `${label} is not strict JSON.`); }
  const subjects = Array.isArray(document?.subject) ? document.subject : [];
  if (!subjects.some((entry) => entry?.name === subject.name
      && entry?.digest?.sha256 === subject.digest.value)) {
    fail("provenanceSubject", `${label} bytes do not contain the declared artifact subject.`);
  }
}
