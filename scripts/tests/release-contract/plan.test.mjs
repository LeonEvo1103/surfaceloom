import assert from "node:assert/strict";
import test from "node:test";
import { packageDescriptor, validatePackageSet } from "../../release/package-graph.mjs";
import { createReleasePlanFromPackageManifests, validateReleasePlan } from "../../release/release-plan.mjs";
import { ReleaseContractError } from "../../release/shape.mjs";
import { loadPackageManifests } from "./helpers/release-fixture.mjs";

test("plan is generated from all seven real package manifests without mutating publish blockers", () => {
  const manifests = loadPackageManifests();
  const plan = createReleasePlanFromPackageManifests(manifests, planInput("pending"));
  assert.equal(plan.packages.length, 7);
  assert.equal(plan.readiness.status, "pending");
  assert.ok(plan.readiness.blockers.some((entry) => entry.endsWith(":private")));
  assert.ok(plan.readiness.blockers.some((entry) => entry.includes(":file:")));
  for (const [index, manifest] of manifests.entries()) {
    assert.deepEqual(plan.packages[index], packageDescriptor(manifest));
    assert.equal(manifest.private, true);
  }
  assert.deepEqual(plan.packageBuildOrder, [
    "@surfaceloom/core", "@surfaceloom/component-catalog", "@surfaceloom/reporter",
    "@surfaceloom/agent-loop", "@surfaceloom/native", "@surfaceloom/browser-playwright",
    "@surfaceloom/test",
  ]);
  assert.doesNotThrow(() => validateReleasePlan(plan));
});

test("package dependency graph rejects a cycle and a missing internal package", () => {
  const packages = loadPackageManifests().map(packageDescriptor);
  const cycle = structuredClone(packages);
  cycle.find((item) => item.name === "@surfaceloom/core").dependencies["@surfaceloom/component-catalog"] = "0.1.0";
  assert.throws(() => validatePackageSet(cycle, { allowLocalDependencies: true }), contract("dependencyCycle"));

  const missing = structuredClone(packages);
  missing[0].dependencies["@surfaceloom/absent"] = "0.1.0";
  assert.throws(() => validatePackageSet(missing, { allowLocalDependencies: true }),
    contract("missingPackageDependency"));
});

test("plan pipeline order and pending fact shape fail closed", () => {
  const plan = createReleasePlanFromPackageManifests(loadPackageManifests(), planInput("pending"));
  const reordered = structuredClone(plan);
  [reordered.pipeline[0], reordered.pipeline[1]] = [reordered.pipeline[1], reordered.pipeline[0]];
  assert.throws(() => validateReleasePlan(reordered), contract("pipelineOrder"));
  const falseFact = structuredClone(plan);
  falseFact.source.revision.value = "0".repeat(40);
  assert.throws(() => validateReleasePlan(falseFact), contract("pendingValue"));
});

test("a plan with local dependencies cannot self-declare ready or omit blockers", () => {
  const plan = structuredClone(createReleasePlanFromPackageManifests(
    loadPackageManifests(), planInput("pending")));
  plan.state = "ready";
  plan.readiness = { status: "ready", blockers: [] };
  assert.throws(() => validateReleasePlan(plan), contract("readiness"));
});

test("component and native-host compatibility versions are strict", () => {
  const component = structuredClone(createReleasePlanFromPackageManifests(
    loadPackageManifests(), planInput("pending")));
  component.protocols.component = "custom/component";
  assert.throws(() => validateReleasePlan(component), contract("protocolVersion"));
  for (const version of ["latest", "01.0.0", "1.0.0-.."]) {
    const host = structuredClone(createReleasePlanFromPackageManifests(
      loadPackageManifests(), planInput("pending")));
    host.protocols.nativeHost = version;
    assert.throws(() => validateReleasePlan(host), contract("protocolVersion"));
  }
});

function planInput(state) {
  return {
    releaseId: "alpha.0.1.0", state,
    targets: [{ id: "linux-x64", os: "linux", arch: "x64", rid: "linux-x64",
      runtime: "node22", deployment: "framework-dependent", minOS: "glibc-2.31", universalSlices: [] }],
    protocols: { npm: "npm-package/1", wire: "surfaceloom.native/1.0",
      report: "surfaceloom.report/v3", trace: "surfaceloom.agent-loop/v1",
      component: "surfaceloom.component-catalog/1", nativeHost: "1.0.0-alpha.1" },
    source: { repository: "https://github.com/LeonEvo1103/surfaceloom",
      revision: { status: "pending" }, snapshotDigest: { status: "pending" },
      dirtyPolicy: "require-clean", lockDigest: { status: "pending" },
      build: { workflow: "release.yml@revision", toolchain: [{ name: "node", version: "22" }], target: "linux-x64" } },
    signingPolicy: { artifacts: { status: "planned", identityPolicy: "platform identity" },
      manifest: { status: "planned", format: "minisign", identityPolicy: "offline identity" } },
    expectedArtifacts: [{ id: "bundle", targetId: "linux-x64", path: "release/bundle.zip",
      kind: "zip", inventoryPaths: ["package/dist/index.js"], signature: { status: "planned" } }],
  };
}

function contract(code) {
  return (error) => error instanceof ReleaseContractError && error.code === code;
}
