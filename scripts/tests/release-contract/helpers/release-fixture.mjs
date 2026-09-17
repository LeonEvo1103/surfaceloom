import { readFileSync } from "node:fs";
import path from "node:path";
import { scanArtifact } from "../../../release/artifact-scan.mjs";
import { digestRecord } from "../../../release/digest.mjs";
import { validatePackageSet } from "../../../release/package-graph.mjs";
import { createReleasePlanFromPackageManifests } from "../../../release/release-plan.mjs";
import { releasePackageNames, releasePipeline } from "../../../release/constants.mjs";
import { zip } from "./archive-builder.mjs";

export function loadPackageManifests(root = process.cwd()) {
  return releasePackageNames.map((name) => {
    const leaf = name.slice("@surfaceloom/".length);
    return JSON.parse(readFileSync(path.join(root, "packages", leaf, "package.json"), "utf8"));
  });
}

export function publishableManifests() {
  const manifests = structuredClone(loadPackageManifests());
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

export function releaseFixture() {
  const manifests = publishableManifests();
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
  });
  const licenseBytes = readFileSync(path.join(process.cwd(), "LICENSE"));
  const dependencyLicenseBytes = readFileSync(path.join(process.cwd(),
    "packages", "browser-playwright", "node_modules", "playwright-core", "LICENSE"));
  const dependencyLicenseText = dependencyLicenseBytes.toString("utf8");
  const noticeBytes = Buffer.from(JSON.stringify({
    schemaVersion: "surfaceloom.third-party-notices/1",
    components: [{
      name: "playwright-core", version: "1.63.0", license: "Apache-2.0",
      licenseText: dependencyLicenseText,
      licenseTextByteLength: dependencyLicenseBytes.length,
      licenseTextDigest: digestRecord(dependencyLicenseBytes),
    }],
  }));
  const provenanceBytes = Buffer.from(JSON.stringify({ subject: [{
    name: "release/surfaceloom.zip", digest: { sha256: receipt.artifactDigest.value },
  }] }));
  const scan = { ...receipt };
  delete scan.inventory;
  delete scan.format;
  delete scan.byteLength;
  const packages = structuredClone(plan.packages);
  const graph = validatePackageSet(packages, { allowLocalDependencies: false });
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
      { type: "library", name: "playwright-core", version: "1.63.0",
        licenses: [{ license: { id: "Apache-2.0" } }] },
      { type: "file", name: artifact.path,
        hashes: [{ alg: "SHA-256", content: artifact.digest.value }] },
      ...artifact.inventory.map((entry) => ({ type: "file", name: `${artifact.path}!/${entry.path}`,
        hashes: [{ alg: "SHA-256", content: entry.digest.value }] })),
    ],
  }));
  const manifest = {
    schemaVersion: "surfaceloom.release-manifest/1", releaseId: plan.releaseId,
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
        coveredDependencyNames: ["playwright-core"] },
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

function aux(path, bytes) {
  return { path, byteLength: bytes.length, digest: digestRecord(bytes) };
}
