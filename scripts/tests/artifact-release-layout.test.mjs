import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function source(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function lineCount(value) {
  return value.split(/\r?\n/u).length;
}

test("ArtifactRelease keeps one stable facade over bounded private responsibilities", async () => {
  const facadePath = "scripts/lib/ArtifactRelease.psm1";
  const privatePaths = [
    "scripts/lib/ArtifactRelease/ArtifactPath.ps1",
    "scripts/lib/ArtifactRelease/ArtifactDirectories.ps1",
    "scripts/lib/ArtifactRelease/ArtifactRecords.ps1",
    "scripts/lib/ArtifactRelease/ArtifactArchive.ps1",
    "scripts/lib/ArtifactRelease/ArtifactSnapshot.ps1",
  ];
  const facade = await source(facadePath);
  const privateSources = await Promise.all(privatePaths.map(source));

  assert.ok(lineCount(facade) <= 250);
  assert.ok(facade.indexOf("FileAttributes]::ReparsePoint") < facade.indexOf(". $privatePath"));
  for (const [index, privateSource] of privateSources.entries()) {
    assert.ok(lineCount(privateSource) <= 250, `${privatePaths[index]} exceeds 250 lines`);
    assert.ok(facade.includes(path.basename(privatePaths[index])));
  }

  const definitions = privateSources
    .flatMap((value) => [...value.matchAll(/^function ([A-Za-z0-9-]+) \{/gmu)])
    .map((match) => match[1])
    .sort();
  const exports = [...facade.matchAll(/^    "([A-Za-z0-9-]+)"[,]?$/gmu)]
    .map((match) => match[1])
    .sort();
  assert.equal(definitions.length, 25);
  assert.deepEqual(exports, definitions);
});

test("artifact release contracts remain one entry over bounded domain scripts", async () => {
  const entry = await source("scripts/test-artifact-release.ps1");
  const contractPaths = [
    "scripts/tests/artifact-release/MetadataSnapshot.Tests.ps1",
    "scripts/tests/artifact-release/ManifestHash.Tests.ps1",
    "scripts/tests/artifact-release/CanonicalArchive.Tests.ps1",
    "scripts/tests/artifact-release/PublicationCleanup.Tests.ps1",
  ];
  const contracts = await Promise.all(contractPaths.map(source));

  assert.ok(lineCount(entry) <= 250);
  assert.match(entry, /ARTIFACT_RELEASE_CONTRACTS=\$passCount\/14/);
  for (const [index, contract] of contracts.entries()) {
    assert.ok(lineCount(contract) <= 250, `${contractPaths[index]} exceeds 250 lines`);
    assert.ok(entry.includes(path.basename(contractPaths[index])));
  }
});
