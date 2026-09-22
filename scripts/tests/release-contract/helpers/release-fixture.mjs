import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { scanArtifact } from "../../../release/artifact-scan.mjs";
import { digestRecord } from "../../../release/digest.mjs";
import { validatePackageSet } from "../../../release/package-graph.mjs";
import { createReleasePlanFromPackageManifests } from "../../../release/release-plan.mjs";
import {
  manifestSchemaVersion, manifestSchemaVersionV1, planSchemaVersion, planSchemaVersionV1,
  releasePackageNames, releasePackageNamesV1, releasePipeline,
} from "../../../release/constants.mjs";
import { zip } from "./archive-builder.mjs";

const dependencyRoots = new Map([
  ["@anthropic-ai/sdk", ["packages", "llm-judge", "node_modules", "@anthropic-ai", "sdk"]],
  ["openai", ["packages", "llm-judge", "node_modules", "openai"]],
  ["playwright-core", ["packages", "browser-playwright", "node_modules", "playwright-core"]],
  ["@modelcontextprotocol/node", ["packages", "service", "node_modules",
    "@modelcontextprotocol", "node"]],
  ["@modelcontextprotocol/server", ["packages", "service", "node_modules",
    "@modelcontextprotocol", "server"]],
  ["zod", ["packages", "service", "node_modules", "zod"]],
]);

export function loadPackageManifests(root = process.cwd()) {
  const discovered = discoverPackageManifests(root);
  assertCurrentPackageProfile(discovered);
  const byName = new Map(discovered.map((manifest) => [manifest.name, manifest]));
  return releasePackageNames.map((name) => byName.get(name));
}

export function loadLegacyPackageManifests(root = process.cwd()) {
  const byName = new Map(discoverPackageManifests(root)
    .map((manifest) => [manifest.name, manifest]));
  const missing = releasePackageNamesV1.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`Legacy release package evidence is missing [${missing.join(", ")}].`);
  }
  return releasePackageNamesV1.map((name) => {
    const manifest = structuredClone(byName.get(name));
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (dependency.startsWith("@surfaceloom/")
            && !releasePackageNamesV1.includes(dependency)) delete manifest[field][dependency];
      }
    }
    for (const dependency of Object.keys(manifest.peerDependenciesMeta ?? {})) {
      if (!releasePackageNamesV1.includes(dependency)) delete manifest.peerDependenciesMeta[dependency];
    }
    return manifest;
  });
}

function discoverPackageManifests(root) {
  const packagesRoot = path.join(root, "packages");
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesRoot, entry.name, "package.json"))
    .filter((manifestPath) => existsSync(manifestPath))
    .map((manifestPath) => JSON.parse(readFileSync(manifestPath, "utf8")))
    .filter((manifest) => manifest.name?.startsWith("@surfaceloom/"));
}

function assertCurrentPackageProfile(discovered) {
  const byName = new Map(discovered.map((manifest) => [manifest.name, manifest]));
  const expected = new Set(releasePackageNames);
  const missing = releasePackageNames.filter((name) => !byName.has(name));
  const unexpected = [...byName.keys()].filter((name) => !expected.has(name)).sort();
  if (missing.length > 0 || unexpected.length > 0 || byName.size !== discovered.length) {
    throw new Error(`Release package profile drift: missing [${missing.join(", ")}], `
      + `unexpected [${unexpected.join(", ")}], discovered ${discovered.length}.`);
  }
}

export function publishableManifests({ schemaVersion = planSchemaVersion } = {}) {
  const manifests = structuredClone(schemaVersion === planSchemaVersionV1
    ? loadLegacyPackageManifests() : loadPackageManifests());
  const versions = new Map(manifests.map((item) => [item.name, item.version]));
  for (const item of manifests) {
    item.private = false;
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(item[field] ?? {})) {
        if (versions.has(name)) item[field][name] = versions.get(name);
      }
    }
  }
  return manifests;
}

export function releaseFixture({ schemaVersion = manifestSchemaVersion } = {}) {
  const legacy = schemaVersion === manifestSchemaVersionV1;
  const planVersion = legacy ? planSchemaVersionV1 : planSchemaVersion;
  const manifests = publishableManifests({ schemaVersion: planVersion });
  const artifactBytes = zip([
    { path: "package/dist/index.js", bytes: "export const ok = true;\n" },
    { path: "package/LICENSE", bytes: "MIT License\n" },
  ]);
  const receipt = scanArtifact(artifactBytes, { kind: "zip", path: "release/surfaceloom.zip" });
  const target = {
    id: "linux-x64", os: "linux", arch: "x64", rid: "linux-x64",
    runtime: "node22", deployment: "framework-dependent", minOS: "glibc-2.31", universalSlices: [],
  };
  const protocols = {
    npm: "npm-package/1", wire: "surfaceloom.native/1.0", report: "surfaceloom.report/v3",
    trace: "surfaceloom.agent-loop/v1", component: "surfaceloom.component-catalog/1",
    nativeHost: "1.0.0-alpha.1",
  };
  const build = {
    workflow: ".github/workflows/release.yml@0123456789abcdef0123456789abcdef01234567",
    toolchain: [{ name: "node", version: "22.22.2" }], target: "release-linux-x64",
  };
  const plan = createReleasePlanFromPackageManifests(manifests, {
    releaseId: "alpha.0.1.0", state: "ready", targets: [target], protocols,
    source: {
      repository: "https://github.com/LeonEvo1103/surfaceloom",
      revision: { status: "pending" }, snapshotDigest: { status: "pending" },
      dirtyPolicy: "require-clean", lockDigest: { status: "pending" }, build,
    },
    signingPolicy: {
      artifacts: { status: "planned", identityPolicy: "platform release identity" },
      manifest: { status: "planned", format: "minisign", identityPolicy: "offline release identity" },
    },
    expectedArtifacts: [{
      id: "bundle", targetId: target.id, path: "release/surfaceloom.zip", kind: "zip",
      inventoryPaths: receipt.inventory.map((entry) => entry.path), signature: { status: "planned" },
    }],
  }, { schemaVersion: planVersion });
  const licenseBytes = readFileSync(path.join(process.cwd(), "LICENSE"));
  const dependencies = thirdPartyDependencies(manifests);
  const noticeBytes = Buffer.from(JSON.stringify({
    schemaVersion: "surfaceloom.third-party-notices/1",
    components: dependencies.map((item) => ({
      name: item.name, version: item.version, license: item.license,
      licenseText: item.licenseBytes.toString("utf8"),
      licenseTextByteLength: item.licenseBytes.length,
      licenseTextDigest: digestRecord(item.licenseBytes),
    })),
  }));
  const provenanceBytes = Buffer.from(JSON.stringify({ subject: [{
    name: "release/surfaceloom.zip", digest: { sha256: receipt.artifactDigest.value },
  }] }));
  const scan = { ...receipt };
  delete scan.inventory;
  delete scan.format;
  delete scan.byteLength;
  const packages = structuredClone(plan.packages);
  const graph = validatePackageSet(packages, {
    allowLocalDependencies: false,
    packageNames: legacy ? releasePackageNamesV1 : releasePackageNames,
  });
  const artifact = {
    id: "bundle", targetId: target.id, path: "release/surfaceloom.zip", kind: "zip",
    byteLength: receipt.byteLength, digest: structuredClone(receipt.artifactDigest),
    inventory: structuredClone(receipt.inventory), scan: structuredClone(scan), signature: { status: "unsigned" },
  };
  const sbomBytes = Buffer.from(JSON.stringify({
    bomFormat: "CycloneDX", specVersion: "1.6",
    components: [
      ...packages.map((item) => ({ type: "library", name: item.name, version: item.version,
        licenses: [{ license: { id: item.license } }] })),
      ...dependencies.map((item) => ({ type: "library", name: item.name, version: item.version,
        licenses: [{ license: { id: item.license } }] })),
      { type: "file", name: artifact.path,
        hashes: [{ alg: "SHA-256", content: artifact.digest.value }] },
      ...artifact.inventory.map((entry) => ({ type: "file", name: `${artifact.path}!/${entry.path}`,
        hashes: [{ alg: "SHA-256", content: entry.digest.value }] })),
    ],
  }));
  const manifest = {
    schemaVersion, releaseId: plan.releaseId,
    packages, packageBuildOrder: graph.buildOrder, targets: [structuredClone(target)],
    protocols: structuredClone(protocols),
    source: {
      repository: "https://github.com/LeonEvo1103/surfaceloom",
      revision: "0123456789abcdef0123456789abcdef01234567",
      snapshotDigest: digestRecord(Buffer.from("source snapshot")),
      dirtyPolicy: { mode: "require-clean" }, lockDigest: digestRecord(Buffer.from("lockfile")),
      build: structuredClone(build),
    },
    artifacts: [artifact],
    sboms: [{ id: "sbom", schema: { name: "CycloneDX", version: "1.6" },
      ...aux("evidence/sbom.cdx.json", sbomBytes),
      coverage: { artifactIds: [artifact.id], packageNames: packages.map((item) => item.name) } }],
    compliance: {
      licenseFiles: [aux("evidence/LICENSE", licenseBytes)],
      noticeFiles: [aux("evidence/THIRD_PARTY_NOTICES", noticeBytes)],
      thirdParty: { status: "complete", coveredPackageNames: packages.map((item) => item.name),
        coveredDependencyNames: dependencies.map((item) => item.name) },
    },
    provenance: [{ id: "provenance", ...aux("evidence/provenance.json", provenanceBytes),
      artifactId: artifact.id, subject: { name: artifact.path, digest: artifact.digest } }],
    pipeline: releasePipeline,
  };
  return {
    plan, manifest, artifactBytes, receipt,
    options: {
      plan,
      artifactEvidence: new Map([[artifact.id, { bytes: artifactBytes, receipt }]]),
      auxiliaryBytes: new Map([
        ["evidence/sbom.cdx.json", sbomBytes], ["evidence/LICENSE", licenseBytes],
        ["evidence/THIRD_PARTY_NOTICES", noticeBytes], ["evidence/provenance.json", provenanceBytes],
      ]),
    },
  };
}

export function releaseFixtureV1() {
  return releaseFixture({ schemaVersion: manifestSchemaVersionV1 });
}

function thirdPartyDependencies(manifests) {
  const internal = new Set(manifests.map((item) => item.name));
  const names = new Set();
  for (const manifest of manifests) {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) if (!internal.has(name)) names.add(name);
    }
  }
  return [...names].sort().map((name) => {
    const segments = dependencyRoots.get(name);
    if (segments === undefined) throw new Error(`No release license fixture is registered for ${name}.`);
    const root = path.join(process.cwd(), ...segments);
    const metadata = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    return { name, version: metadata.version, license: metadata.license,
      licenseBytes: readFileSync(path.join(root, "LICENSE")) };
  });
}

function aux(path, bytes) {
  return { path, byteLength: bytes.length, digest: digestRecord(bytes) };
}
