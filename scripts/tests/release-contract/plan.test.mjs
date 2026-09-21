import assert from "node:assert/strict";
import test from "node:test";
import { packageDescriptor, validatePackageSet } from "../../release/package-graph.mjs";
import { createReleasePlanFromPackageManifests, validateReleasePlan } from "../../release/release-plan.mjs";
import {
  planSchemaVersion, planSchemaVersionV1, releasePackageNames, releasePackageNamesV1,
} from "../../release/constants.mjs";
import { ReleaseContractError } from "../../release/shape.mjs";
import {
  loadLegacyPackageManifests, loadPackageManifests, publishableManifests,
} from "./helpers/release-fixture.mjs";

test("plan is generated from all seven v1 package manifests without mutating publish blockers", () => {
  const manifests = loadLegacyPackageManifests();
  const plan = createReleasePlanFromPackageManifests(
    manifests, planInput("pending"), { schemaVersion: planSchemaVersionV1 });
  assert.equal(plan.schemaVersion, planSchemaVersionV1);
  assert.equal(plan.packages.length, 7);
  assert.deepEqual(plan.packages.map((item) => item.name), releasePackageNamesV1);
  assert.equal(plan.readiness.status, "pending");
  assert.ok(plan.readiness.blockers.some((entry) => entry.endsWith(":private")));
  assert.ok(plan.readiness.blockers.some((entry) => entry.includes(":file:")));
  for (const [index, manifest] of manifests.entries()) {
    assert.deepEqual(plan.packages[index], packageDescriptor(manifest));
    assert.equal(manifest.private, true);
  }
  assert.deepEqual(plan.packageBuildOrder, [
    "@surfaceloom/core", "@surfaceloom/component-catalog", "@surfaceloom/reporter",
    "@surfaceloom/agent-loop", "@surfaceloom/test", "@surfaceloom/native",
    "@surfaceloom/browser-playwright",
  ]);
  const native = plan.packages.find((item) => item.name === "@surfaceloom/native");
  assert.deepEqual(Object.keys(native.peerDependenciesMeta), ["@surfaceloom/test"]);
  assert.deepEqual(native.peerDependenciesMeta["@surfaceloom/test"], { optional: true });
  const browser = plan.packages.find((item) => item.name === "@surfaceloom/browser-playwright");
  assert.deepEqual(Object.keys(browser.peerDependenciesMeta), ["@surfaceloom/test"]);
  assert.deepEqual(browser.peerDependenciesMeta["@surfaceloom/test"], { optional: true });
  assert.doesNotThrow(() => validateReleasePlan(plan));
});

test("v1 preserves the historical package iteration tie-break when optional peer edges are absent", () => {
  const manifests = loadLegacyPackageManifests();
  for (const name of ["@surfaceloom/native", "@surfaceloom/browser-playwright"]) {
    const manifest = manifests.find((item) => item.name === name);
    delete manifest.peerDependencies?.["@surfaceloom/test"];
    delete manifest.peerDependenciesMeta?.["@surfaceloom/test"];
  }
  const plan = createReleasePlanFromPackageManifests(
    manifests, planInput("pending"), { schemaVersion: planSchemaVersionV1 });

  assert.deepEqual(plan.packages.map((item) => item.name), [
    "@surfaceloom/core", "@surfaceloom/component-catalog", "@surfaceloom/reporter",
    "@surfaceloom/agent-loop", "@surfaceloom/native", "@surfaceloom/browser-playwright",
    "@surfaceloom/test",
  ]);
  assert.deepEqual(plan.packageBuildOrder, plan.packages.map((item) => item.name));
  assert.doesNotThrow(() => validateReleasePlan(plan));
});

test("v2 plan is generated from every real release package manifest", () => {
  const manifests = loadPackageManifests();
  const plan = createReleasePlanFromPackageManifests(manifests, planInput("pending"));
  assert.equal(plan.schemaVersion, planSchemaVersion);
  assert.equal(plan.packages.length, releasePackageNames.length);
  assert.deepEqual(plan.packages.map((item) => item.name), releasePackageNames);
  assert.deepEqual(plan.packageBuildOrder, [
    "@surfaceloom/core", "@surfaceloom/component-catalog", "@surfaceloom/reporter",
    "@surfaceloom/agent-loop", "@surfaceloom/llm-judge", "@surfaceloom/test",
    "@surfaceloom/service", "@surfaceloom/native", "@surfaceloom/browser-playwright",
  ]);
  const testPackage = plan.packages.find((item) => item.name === "@surfaceloom/test");
  assert.equal(testPackage.dependencies["@surfaceloom/llm-judge"], "file:../llm-judge");
  assert.ok(plan.packageBuildOrder.indexOf("@surfaceloom/llm-judge")
    < plan.packageBuildOrder.indexOf("@surfaceloom/test"));
  const servicePackage = plan.packages.find((item) => item.name === "@surfaceloom/service");
  assert.equal(servicePackage.dependencies["@surfaceloom/test"], "file:../test");
  assert.ok(plan.packageBuildOrder.indexOf("@surfaceloom/test")
    < plan.packageBuildOrder.indexOf("@surfaceloom/service"));
  assert.doesNotThrow(() => validateReleasePlan(plan));
});

test("peer metadata is strict release data and never executes hostile objects", () => {
  const browser = loadPackageManifests().find((item) =>
    item.name === "@surfaceloom/browser-playwright");

  const unknown = structuredClone(browser);
  unknown.peerDependenciesMeta["@surfaceloom/absent"] = { optional: true };
  assert.throws(() => packageDescriptor(unknown), contract("unknownPeerMetadata"));

  const nonBoolean = structuredClone(browser);
  nonBoolean.peerDependenciesMeta["@surfaceloom/test"].optional = "true";
  assert.throws(() => packageDescriptor(nonBoolean), contract("invalidPeerMetadata"));

  const extra = structuredClone(browser);
  extra.peerDependenciesMeta["@surfaceloom/test"].reason = "optional subpath";
  assert.throws(() => packageDescriptor(extra), contract("unexpectedField"));

  const accessor = structuredClone(browser);
  Object.defineProperty(accessor.peerDependenciesMeta["@surfaceloom/test"], "optional", {
    enumerable: true,
    get() { throw new Error("must not execute"); },
  });
  assert.throws(() => packageDescriptor(accessor), contract("accessor"));

  let traps = 0;
  const proxied = structuredClone(browser);
  proxied.peerDependenciesMeta = new Proxy(proxied.peerDependenciesMeta, {
    get() { traps += 1; throw new Error("must not execute"); },
  });
  assert.throws(() => packageDescriptor(proxied), contract("invalidRecord"));
  assert.equal(traps, 0);
});

test("an optional internal peer participates in graph order and release version blocking", () => {
  const packages = loadPackageManifests().map(packageDescriptor);
  const graph = validatePackageSet(packages, { allowLocalDependencies: true });
  assert.ok(graph.buildOrder.indexOf("@surfaceloom/test")
    < graph.buildOrder.indexOf("@surfaceloom/native"));
  assert.ok(graph.buildOrder.indexOf("@surfaceloom/test")
    < graph.buildOrder.indexOf("@surfaceloom/browser-playwright"));

  const incompatibleManifests = publishableManifests();
  incompatibleManifests.find((item) => item.name === "@surfaceloom/browser-playwright")
    .peerDependencies["@surfaceloom/test"] = "0.1.1";
  const incompatible = incompatibleManifests.map(packageDescriptor);
  assert.throws(() => validatePackageSet(incompatible, { allowLocalDependencies: false }),
    contract("dependencyVersion"));

  const fabricated = structuredClone(packages);
  fabricated.find((item) => item.name === "@surfaceloom/browser-playwright")
    .peerDependenciesMeta["@surfaceloom/absent"] = { optional: true };
  assert.throws(() => validatePackageSet(fabricated, { allowLocalDependencies: true }),
    contract("unknownPeerMetadata"));
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

test("versioned package profiles reject cross-version, missing, and extra packages", () => {
  const packages = loadPackageManifests().map(packageDescriptor);
  assert.throws(() => validatePackageSet(packages, {
    allowLocalDependencies: true, packageNames: releasePackageNamesV1,
  }), contract("packageCount"));
  for (const name of ["@surfaceloom/service", "@surfaceloom/llm-judge"]) {
    assert.throws(() => validatePackageSet(
      packages.filter((item) => item.name !== name), { allowLocalDependencies: true }),
    contract("packageCount"));
  }
  const extra = [...packages, structuredClone(packages[0])];
  extra.at(-1).name = "@surfaceloom/extra";
  assert.throws(() => validatePackageSet(extra, { allowLocalDependencies: true }),
    contract("packageCount"));
  assert.throws(() => validateReleasePlan({
    ...createReleasePlanFromPackageManifests(
      loadLegacyPackageManifests(), planInput("pending"), { schemaVersion: planSchemaVersionV1 }),
    packages,
  }), contract("packageCount"));
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
