import assert from "node:assert/strict";
import test from "node:test";
import { assertScanBindsPublishedBytes } from "../../release/artifact-scan.mjs";
import { canonicalInventoryDigest, digestRecord } from "../../release/digest.mjs";
import {
  manifestSchemaVersion, manifestSchemaVersionV1, releasePackageNames, releasePackageNamesV1,
} from "../../release/constants.mjs";
import { validateReleaseManifest } from "../../release/release-manifest.mjs";
import { ReleaseContractError } from "../../release/shape.mjs";
import { releaseFixture, releaseFixtureV1 } from "./helpers/release-fixture.mjs";

test("final manifest validates exact bytes, inventory, SBOM, licenses, and provenance", () => {
  const fixture = releaseFixture();
  assert.equal(fixture.manifest.schemaVersion, manifestSchemaVersion);
  assert.doesNotThrow(() => validateReleaseManifest(fixture.manifest, fixture.options));
});

test("v1 manifest and SBOM evidence remain valid for exactly the original seven packages", () => {
  const fixture = releaseFixtureV1();
  assert.equal(fixture.manifest.schemaVersion, manifestSchemaVersionV1);
  assert.deepEqual(fixture.manifest.packages.map((item) => item.name), releasePackageNamesV1);
  const document = JSON.parse(fixture.options.auxiliaryBytes.get("evidence/sbom.cdx.json"));
  assert.deepEqual(document.components
    .filter((entry) => entry.name.startsWith("@surfaceloom/"))
    .map((entry) => entry.name), releasePackageNamesV1);
  assert.doesNotThrow(() => validateReleaseManifest(fixture.manifest, fixture.options));
});

test("historical v1 manifest without optional test peer edges keeps its original build order", () => {
  const fixture = releaseFixtureV1();
  const plan = structuredClone(fixture.plan);
  const historicalOrder = [
    "@surfaceloom/core", "@surfaceloom/component-catalog", "@surfaceloom/reporter",
    "@surfaceloom/agent-loop", "@surfaceloom/native", "@surfaceloom/browser-playwright",
    "@surfaceloom/test",
  ];
  for (const packages of [plan.packages, fixture.manifest.packages]) {
    for (const name of ["@surfaceloom/native", "@surfaceloom/browser-playwright"]) {
      const entry = packages.find((item) => item.name === name);
      delete entry.peerDependencies["@surfaceloom/test"];
      delete entry.peerDependenciesMeta["@surfaceloom/test"];
    }
  }
  plan.packageBuildOrder = historicalOrder;
  fixture.manifest.packageBuildOrder = historicalOrder;
  fixture.options.plan = plan;

  assert.doesNotThrow(() => validateReleaseManifest(fixture.manifest, fixture.options));
});

test("manifest schema versions reject the other package profile", () => {
  const legacy = releaseFixtureV1();
  const current = releaseFixture();
  legacy.manifest.packages = current.manifest.packages;
  legacy.manifest.packageBuildOrder = current.manifest.packageBuildOrder;
  assert.throws(() => validateReleaseManifest(legacy.manifest, legacy.options),
    contract("packageCount"));

  current.manifest.packages = releaseFixtureV1().manifest.packages;
  assert.throws(() => validateReleaseManifest(current.manifest, current.options),
    contract("packageCount"));

  const mismatchedPlan = releaseFixture();
  mismatchedPlan.options.plan = releaseFixtureV1().plan;
  assert.throws(() => validateReleaseManifest(mismatchedPlan.manifest, mismatchedPlan.options),
    contract("planVersion"));
});

test("one changed artifact byte and scan-A/publish-B both fail closed", () => {
  const fixture = releaseFixture();
  const changed = Buffer.from(fixture.artifactBytes);
  changed[changed.length - 1] ^= 1;
  assert.throws(() => assertScanBindsPublishedBytes(fixture.receipt, changed),
    contract("scanPublishMismatch"));
  fixture.options.artifactEvidence.set("bundle", { bytes: changed, receipt: fixture.receipt });
  assert.throws(() => validateReleaseManifest(fixture.manifest, fixture.options),
    contract("scanPublishMismatch"));
});

test("missing, extra, or altered inventory and artifact evidence are rejected", () => {
  const missing = releaseFixture();
  missing.manifest.artifacts[0].inventory = missing.manifest.artifacts[0].inventory.slice(1);
  missing.manifest.artifacts[0].scan.entryCount = 1;
  missing.manifest.artifacts[0].scan.inventoryDigest = canonicalInventoryDigest(
    missing.manifest.artifacts[0].inventory);
  assert.throws(() => validateReleaseManifest(missing.manifest, missing.options),
    contract("artifactEvidence"));

  const altered = releaseFixture();
  altered.manifest.artifacts[0].inventory[0].byteLength += 1;
  altered.manifest.artifacts[0].scan.inventoryDigest = canonicalInventoryDigest(
    altered.manifest.artifacts[0].inventory);
  assert.throws(() => validateReleaseManifest(altered.manifest, altered.options),
    contract("artifactEvidence"));

  const extra = releaseFixture();
  extra.options.artifactEvidence.set("undeclared", extra.options.artifactEvidence.get("bundle"));
  assert.throws(() => validateReleaseManifest(extra.manifest, extra.options), contract("extraArtifact"));
  const absent = releaseFixture();
  absent.options.artifactEvidence.delete("bundle");
  assert.throws(() => validateReleaseManifest(absent.manifest, absent.options), ReleaseContractError);
});

test("package version and host architecture/runtime cannot drift from the plan", () => {
  const version = releaseFixture();
  version.manifest.packages[0].version = "0.1.1";
  assert.throws(() => validateReleaseManifest(version.manifest, version.options), ReleaseContractError);

  const architecture = releaseFixture();
  architecture.manifest.targets[0].arch = "arm64";
  architecture.manifest.targets[0].rid = "linux-arm64";
  assert.throws(() => validateReleaseManifest(architecture.manifest, architecture.options),
    contract("compatibilityMismatch"));

  const runtime = releaseFixture();
  runtime.manifest.targets[0].runtime = "node23";
  assert.throws(() => validateReleaseManifest(runtime.manifest, runtime.options),
    contract("compatibilityMismatch"));
});

test("SBOM coverage and provenance subject must cover the exact artifact/package set", () => {
  const coverage = releaseFixture();
  coverage.manifest.sboms[0].coverage.packageNames.pop();
  assert.throws(() => validateReleaseManifest(coverage.manifest, coverage.options), contract("coverage"));

  const provenance = releaseFixture();
  provenance.manifest.provenance[0].subject.digest = digestRecord(Buffer.from("other artifact"));
  assert.throws(() => validateReleaseManifest(provenance.manifest, provenance.options),
    contract("provenanceSubject"));
});

test("verified signature evidence binds final bytes and detects post-signing modification", () => {
  const fixture = releaseFixture();
  const artifact = fixture.manifest.artifacts[0];
  const signatureBytes = Buffer.from("verified platform signature evidence");
  artifact.signature = {
    status: "verified", identity: "CN=SurfaceLoom Release",
    evidence: { kind: "embedded-verification", path: "evidence/signature.json",
      byteLength: signatureBytes.length, digest: digestRecord(signatureBytes),
      subjectDigest: artifact.digest },
  };
  fixture.options.auxiliaryBytes.set("evidence/signature.json", signatureBytes);
  validateReleaseManifest(fixture.manifest, fixture.options);

  const changed = Buffer.from(fixture.artifactBytes);
  changed[40] ^= 1;
  fixture.options.artifactEvidence.set("bundle", { bytes: changed, receipt: fixture.receipt });
  assert.throws(() => validateReleaseManifest(fixture.manifest, fixture.options),
    contract("scanPublishMismatch"));
});

test("manifest forbids pending, zero/source hashes, planned signatures, and secret material", () => {
  const pending = releaseFixture();
  pending.manifest.source.revision = "pending";
  assert.throws(() => validateReleaseManifest(pending.manifest, pending.options), contract("pendingFact"));

  const zero = releaseFixture();
  zero.manifest.artifacts[0].digest.value = "0".repeat(64);
  assert.throws(() => validateReleaseManifest(zero.manifest, zero.options), contract("invalidDigest"));

  const masquerade = releaseFixture();
  masquerade.manifest.source.snapshotDigest = masquerade.manifest.artifacts[0].digest;
  assert.throws(() => validateReleaseManifest(masquerade.manifest, masquerade.options),
    contract("sourceDigestMasquerade"));

  const planned = releaseFixture();
  planned.manifest.artifacts[0].signature = { status: "planned" };
  assert.throws(() => validateReleaseManifest(planned.manifest, planned.options), contract("invalidEnum"));

  const secret = releaseFixture();
  secret.manifest.signingToken = "do-not-store";
  assert.throws(() => validateReleaseManifest(secret.manifest, secret.options), contract("secretMaterial"));
});

test("protocol compatibility and auxiliary evidence bytes cannot be relabeled", () => {
  const protocol = releaseFixture();
  protocol.manifest.protocols.wire = "surfaceloom.native/0.2";
  assert.throws(() => validateReleaseManifest(protocol.manifest, protocol.options),
    contract("protocolVersion"));

  const sbom = releaseFixture();
  sbom.options.auxiliaryBytes.set("evidence/sbom.cdx.json", Buffer.from("{}"));
  assert.throws(() => validateReleaseManifest(sbom.manifest, sbom.options), contract("evidenceDigest"));
});

test("digest comparison uses algorithm/value semantics instead of object key order", () => {
  const fixture = releaseFixture();
  const artifact = fixture.manifest.artifacts[0];
  artifact.digest = { value: artifact.digest.value, algorithm: "sha256" };
  artifact.scan.artifactDigest = { value: artifact.scan.artifactDigest.value, algorithm: "sha256" };
  artifact.inventory[0].digest = {
    value: artifact.inventory[0].digest.value, algorithm: "sha256",
  };
  fixture.manifest.provenance[0].subject.digest = {
    value: artifact.digest.value, algorithm: "sha256",
  };
  assert.doesNotThrow(() => validateReleaseManifest(fixture.manifest, fixture.options));
});

test("SBOM bytes must derive every release package, dependency, artifact, and inventory component", () => {
  const baseline = releaseFixture();
  const baselineDocument = JSON.parse(
    baseline.options.auxiliaryBytes.get("evidence/sbom.cdx.json"));
  assert.deepEqual(baselineDocument.components
    .filter((entry) => entry.name.startsWith("@surfaceloom/"))
    .map((entry) => entry.name), releasePackageNames);
  for (const remove of [
    (components) => components.findIndex((entry) => entry.name === "@surfaceloom/core"),
    (components) => components.findIndex((entry) => entry.name === "@surfaceloom/llm-judge"),
    (components) => components.findIndex((entry) => entry.name === "@surfaceloom/service"),
    (components) => components.findIndex((entry) => entry.name === "release/surfaceloom.zip"),
    (components) => components.findIndex((entry) => entry.name.includes("!/package/LICENSE")),
    (components) => components.findIndex((entry) => entry.name === "playwright-core"),
  ]) {
    const fixture = releaseFixture();
    const document = JSON.parse(fixture.options.auxiliaryBytes.get("evidence/sbom.cdx.json"));
    document.components.splice(remove(document.components), 1);
    replaceAuxiliary(fixture, fixture.manifest.sboms[0], Buffer.from(JSON.stringify(document)));
    assert.throws(() => validateReleaseManifest(fixture.manifest, fixture.options),
      contract("sbomComponents"));
  }
  const empty = releaseFixture();
  const document = { bomFormat: "CycloneDX", specVersion: "1.6", components: [] };
  replaceAuxiliary(empty, empty.manifest.sboms[0], Buffer.from(JSON.stringify(document)));
  assert.throws(() => validateReleaseManifest(empty.manifest, empty.options), contract("sbomComponents"));

  const incompatible = releaseFixture();
  const incompatibleDocument = JSON.parse(
    incompatible.options.auxiliaryBytes.get("evidence/sbom.cdx.json"));
  incompatibleDocument.components.find((entry) => entry.name === "playwright-core").version = "9.9.9";
  replaceAuxiliary(incompatible, incompatible.manifest.sboms[0],
    Buffer.from(JSON.stringify(incompatibleDocument)));
  assert.throws(() => validateReleaseManifest(incompatible.manifest, incompatible.options),
    contract("sbomComponents"));
});

test("license and NOTICE bytes must substantiate claimed package/dependency coverage", () => {
  const baseline = releaseFixture();
  assert.deepEqual(baseline.manifest.compliance.thirdParty.coveredPackageNames,
    releasePackageNames);
  assert.deepEqual(baseline.manifest.compliance.thirdParty.coveredDependencyNames,
    ["playwright-core"]);

  const packageCoverage = releaseFixture();
  packageCoverage.manifest.compliance.thirdParty.coveredPackageNames =
    packageCoverage.manifest.compliance.thirdParty.coveredPackageNames
      .filter((name) => name !== "@surfaceloom/service");
  assert.throws(() => validateReleaseManifest(packageCoverage.manifest, packageCoverage.options),
    contract("coverage"));

  const license = releaseFixture();
  replaceAuxiliary(license, license.manifest.compliance.licenseFiles[0],
    Buffer.from("A file named LICENSE without license terms\n"));
  assert.throws(() => validateReleaseManifest(license.manifest, license.options),
    contract("licenseEvidence"));

  const notice = releaseFixture();
  replaceAuxiliary(notice, notice.manifest.compliance.noticeFiles[0],
    Buffer.from("All third-party dependencies are covered.\n"));
  assert.throws(() => validateReleaseManifest(notice.manifest, notice.options),
    contract("noticeEvidence"));

  const fabricated = releaseFixture();
  const fabricatedText = "Apache License Version 2.0 TERMS AND CONDITIONS FOR USE, "
    + "REPRODUCTION, AND DISTRIBUTION END OF TERMS AND CONDITIONS";
  const fabricatedBytes = Buffer.from(fabricatedText);
  replaceAuxiliary(fabricated, fabricated.manifest.compliance.noticeFiles[0], Buffer.from(JSON.stringify({
    schemaVersion: "surfaceloom.third-party-notices/1",
    components: [{
      name: "playwright-core", version: "1.63.0", license: "Apache-2.0",
      licenseText: fabricatedText, licenseTextByteLength: fabricatedBytes.length,
      licenseTextDigest: digestRecord(fabricatedBytes),
    }],
  })));
  assert.throws(() => validateReleaseManifest(fabricated.manifest, fabricated.options),
    contract("noticeEvidence"));
});

function contract(code) {
  return (error) => error instanceof ReleaseContractError && error.code === code;
}

function replaceAuxiliary(fixture, record, bytes) {
  record.byteLength = bytes.length;
  record.digest = digestRecord(bytes);
  fixture.options.auxiliaryBytes.set(record.path, bytes);
}
