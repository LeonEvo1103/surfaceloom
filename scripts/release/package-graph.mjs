import { releasePackageNames, strictSemverPattern } from "./constants.mjs";
import { dictionary, fail, list, record, sameJson, string } from "./shape.mjs";

const packageFields = [
  "name", "version", "dependencies", "peerDependencies", "optionalDependencies",
  "exports", "bin", "assets", "license",
];
const sourceManifestFields = [
  "name", "version", "license", "private", "repository", "type", "main", "types",
  "exports", "bin", "files", "scripts", "dependencies", "peerDependencies",
  "optionalDependencies", "devDependencies", "engines",
];

export function packageDescriptor(packageJson) {
  const source = record(packageJson, "package manifest", sourceManifestFields, ["name", "version", "license"]);
  return Object.freeze({
    name: string(source.name, "package name"),
    version: string(source.version, "package version", strictSemverPattern),
    dependencies: dependencyMap(source.dependencies, "dependencies"),
    peerDependencies: dependencyMap(source.peerDependencies, "peerDependencies"),
    optionalDependencies: dependencyMap(source.optionalDependencies, "optionalDependencies"),
    exports: jsonValue(source.exports ?? {}, "exports"),
    bin: jsonValue(source.bin ?? {}, "bin"),
    assets: Object.freeze(list(source.files ?? [], "files").map((entry, index) =>
      string(entry, `files[${index}]`))),
    license: string(source.license, "package license"),
  });
}

export function validatePackageSet(value, { allowLocalDependencies }) {
  const packages = list(value, "packages", { min: releasePackageNames.length });
  if (packages.length !== releasePackageNames.length) fail("packageCount", "Release must contain exactly seven packages.");
  const byName = new Map();
  for (const [index, input] of packages.entries()) {
    const item = record(input, `packages[${index}]`, packageFields);
    string(item.name, `packages[${index}].name`);
    string(item.version, `packages[${index}].version`, strictSemverPattern);
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      item[field] = dependencyMap(item[field], `${item.name}.${field}`);
      if (!allowLocalDependencies) {
        for (const range of Object.values(item[field])) {
          if (/^(?:file|link|workspace):/u.test(range)) fail("localDependency", "Final package dependencies must be publishable.");
        }
      }
    }
    item.exports = jsonValue(item.exports, `${item.name}.exports`);
    item.bin = jsonValue(item.bin, `${item.name}.bin`);
    const assets = list(item.assets, `${item.name}.assets`);
    const assetNames = assets.map((entry, index) => string(entry, `${item.name}.assets[${index}]`));
    if (new Set(assetNames).size !== assetNames.length) fail("duplicateAsset", `${item.name}.assets contains duplicates.`);
    if (string(item.license, `${item.name}.license`) !== "MIT") fail("packageLicense", `${item.name} must declare MIT.`);
    if (byName.has(item.name)) fail("duplicatePackage", `Duplicate package ${item.name}.`);
    byName.set(item.name, item);
  }
  for (const name of releasePackageNames) {
    if (!byName.has(name)) fail("missingPackage", `Missing release package ${name}.`);
  }
  for (const name of byName.keys()) {
    if (!releasePackageNames.includes(name)) fail("unexpectedPackage", `Unexpected release package ${name}.`);
  }
  if (!allowLocalDependencies) {
    for (const item of packages) {
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        for (const [name, range] of Object.entries(item[field])) {
          const dependency = byName.get(name);
          if (dependency !== undefined && range !== dependency.version) {
            fail("dependencyVersion", `${item.name} must pin ${name} to ${dependency.version}.`);
          }
        }
      }
    }
  }
  return { packages, byName, buildOrder: topologicalOrder(byName) };
}

export function assertPackageSnapshotMatches(actual, expected) {
  if (!sameJson(actual, expected)) fail("packageMismatch", "Plan and manifest package snapshots differ.");
}

export function localDependencyBlockers(packages) {
  const blockers = [];
  for (const item of packages) {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, range] of Object.entries(item[field])) {
        if (/^(?:file|link|workspace):/u.test(range)) blockers.push(`${item.name}:${field}:${name}:${range}`);
      }
    }
  }
  return blockers.sort();
}

function topologicalOrder(byName) {
  const visiting = new Set();
  const visited = new Set();
  const output = [];
  const visit = (name) => {
    if (visiting.has(name)) fail("dependencyCycle", `Release package dependency cycle includes ${name}.`);
    if (visited.has(name)) return;
    visiting.add(name);
    const item = byName.get(name);
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dependency of Object.keys(item[field]).sort()) {
        if (dependency.startsWith("@surfaceloom/") && !byName.has(dependency)) {
          fail("missingPackageDependency", `${name} depends on absent ${dependency}.`);
        }
        if (byName.has(dependency)) visit(dependency);
      }
    }
    visiting.delete(name);
    visited.add(name);
    output.push(name);
  };
  for (const name of releasePackageNames) visit(name);
  return Object.freeze(output);
}

function dependencyMap(value, label) {
  if (value === undefined) return Object.freeze({});
  const input = dictionary(value, label);
  const output = Object.create(null);
  for (const [name, range] of Object.entries(input)) output[string(name, `${label} name`)] = string(range, `${label}.${name}`);
  return Object.freeze(output);
}

function jsonValue(value, label, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))) return value;
  if (seen.has(value)) fail("invalidPackageMetadata", `${label} contains a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) return Object.freeze(value.map((entry, index) => jsonValue(entry, `${label}[${index}]`, seen)));
  const input = dictionary(value, label);
  const output = Object.create(null);
  for (const [key, entry] of Object.entries(input)) output[key] = jsonValue(entry, `${label}.${key}`, seen);
  seen.delete(value);
  return Object.freeze(output);
}
