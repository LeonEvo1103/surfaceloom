import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { scanArtifact } from "../../release/artifact-scan.mjs";
import { defaultScanLimits } from "../../release/constants.mjs";
import { ReleaseContractError } from "../../release/shape.mjs";
import { pe, tar, tgz, zip } from "./helpers/archive-builder.mjs";

const attacks = JSON.parse(await readFile(new URL("./fixtures/archive-attacks.json", import.meta.url), "utf8"));

test("scanner identifies ZIP, TGZ, PE, and app containers by magic", () => {
  const zipBytes = zip([{ path: "package/index.js", bytes: "ok" }]);
  const tgzBytes = tgz([{ path: "package/index.js", bytes: "ok" }]);
  const appBytes = zip([{ path: "SurfaceLoom.app/Contents/MacOS/host", bytes: pe() }]);
  assert.equal(scanArtifact(zipBytes, { kind: "zip", path: "a.zip" }).format, "zip");
  assert.equal(scanArtifact(tgzBytes, { kind: "tgz", path: "a.tgz" }).format, "gzip");
  assert.equal(scanArtifact(pe(), { kind: "exe", path: "a.exe" }).format, "pe");
  assert.equal(scanArtifact(appBytes, { kind: "app", path: "a.app.zip" }).format, "zip");
  assert.throws(() => scanArtifact(Buffer.from("not zip"), { kind: "zip", path: "a.zip" }),
    contract("artifactMagic"));
});

test("archive paths reject traversal, absolute paths, ADS, aliases, duplicates, and case collisions", () => {
  for (const path of attacks.unsafePaths) {
    assert.throws(() => scanZip([{ path, bytes: "x" }]), ReleaseContractError, path);
  }
  assert.throws(() => scanZip(attacks.caseCollision.map((path) => ({ path, bytes: "x" }))),
    contract("caseCollision"));
  assert.throws(() => scanZip([{ path: "same", bytes: "a" }, { path: "same", bytes: "b" }]),
    contract("duplicateArchivePath"));
});

test("archive metadata rejects symlink, hardlink, reparse, encrypted, and unknown methods", () => {
  assert.throws(() => scanZip([{ path: "link", bytes: "target",
    externalAttributes: 0o120777 << 16 }]), contract("symbolicLink"));
  assert.throws(() => scanArtifact(tgz([{ path: "hard", type: "1", linkName: "target" }]),
    { kind: "tgz", path: "a.tgz" }), contract("hardLink"));
  assert.throws(() => scanArtifact(tgz([{ path: "sym", type: "2", linkName: "target" }]),
    { kind: "tgz", path: "a.tgz" }), contract("symbolicLink"));
  assert.throws(() => scanZip([{ path: "reparse", bytes: "x", externalAttributes: 0x400 }]),
    contract("reparsePoint"));
  assert.throws(() => scanZip([{ path: "secret", bytes: "x", flags: 0x801 }]),
    contract("encryptedArchive"));
  assert.throws(() => scanZip([{ path: "unknown", bytes: "x", method: 99 }]),
    contract("unknownCompression"));
});

test("archive bombs fail on entry size, total size, ratio, count, and recursion depth", () => {
  assert.throws(() => scanZip([{ path: "large", bytes: "1234" }], limits({ maxEntryBytes: 3 })),
    contract("archiveBomb"));
  assert.throws(() => scanZip([{ path: "a", bytes: "12" }, { path: "b", bytes: "34" }],
    limits({ maxTotalBytes: 3 })), contract("archiveBomb"));
  assert.throws(() => scanZip([{ path: "ratio", bytes: "x", declaredSize: 1000 }],
    limits({ maxCompressionRatio: 10 })), contract("archiveBomb"));
  assert.throws(() => scanZip([{ path: "a", bytes: "1" }, { path: "b", bytes: "2" }],
    limits({ maxEntries: 1 })), ReleaseContractError);
  let nested = zip([{ path: "leaf", bytes: "ok" }]);
  for (let index = 0; index < 3; index += 1) nested = zip([{ path: `nested-${index}.zip`, bytes: nested }]);
  assert.throws(() => scanArtifact(nested, { kind: "zip", path: "a.zip", limits: limits({ maxDepth: 1 }) }),
    contract("archiveDepth"));
});

test("recursive scan inspects nested assets and rejects unknown containers, sources, debug files, and paths", () => {
  const inner = zip([{ path: "dist/index.js", bytes: "ok" }]);
  const receipt = scanZip([{ path: "assets/payload.bin", bytes: inner }]);
  assert.deepEqual(receipt.inventory.map((entry) => entry.path), [
    "assets/payload.bin", "assets/payload.bin!/dist/index.js",
  ]);
  const nestedTar = tar([{ path: "package/native.node", bytes: "binary" }]);
  const tarReceipt = scanZip([{ path: "assets/native.tar", bytes: nestedTar }]);
  assert.ok(tarReceipt.inventory.some((entry) =>
    entry.path === "assets/native.tar!/package/native.node"));
  const sevenZip = Buffer.from("377abcaf271c0001", "hex");
  assert.throws(() => scanZip([{ path: "assets/blob.bin", bytes: sevenZip }]),
    contract("unknownContainer"));
  const sourceMap = zip([{ path: "dist/app.js.map",
    bytes: JSON.stringify({ version: 3, sourcesContent: ["secret source"] }) }]);
  assert.throws(() => scanZip([{ path: "nested.zip", bytes: sourceMap }]), contract("embeddedSources"));
  for (const path of attacks.debugPaths) {
    assert.throws(() => scanZip([{ path, bytes: "symbols" }]), contract("debugArtifact"));
  }
  assert.throws(() => scanZip([{ path: "dist/meta.txt", bytes: "built at /Users/alice/repo" }]),
    contract("absoluteBuildPath"));
});

test("ZIP central directory owns the complete local region and exact local facts", () => {
  const base = zip([{ path: "package/file.js", bytes: "ok" }]);
  assert.throws(() => scanArtifact(withHiddenLocalBytes(base), { kind: "zip", path: "release.zip" }),
    contract("hiddenLocalHeader"));
  for (const [offset, value] of [[6, 0x801], [8, 8], [14, 1], [18, 1], [22, 1]]) {
    const changed = Buffer.from(base);
    if (offset === 14 || offset === 18 || offset === 22) changed.writeUInt32LE(value, offset);
    else changed.writeUInt16LE(value, offset);
    assert.throws(() => scanArtifact(changed, { kind: "zip", path: "release.zip" }), ReleaseContractError);
  }
  const renamed = Buffer.from(base);
  renamed[30] ^= 1;
  assert.throws(() => scanArtifact(renamed, { kind: "zip", path: "release.zip" }), ReleaseContractError);
});

test("ZIP rejects special Unix types, ancestor conflicts, and aggregate output before inflate", () => {
  assert.throws(() => scanZip([{ path: "pipe", bytes: "", externalAttributes: 0o010644 << 16 }]),
    contract("unknownUnixType"));
  assert.throws(() => scanZip([{ path: "a", bytes: "file" }, { path: "a/child", bytes: "child" }]),
    contract("fileDirectoryConflict"));
  assert.throws(() => scanZip([{ path: "a/child", bytes: "child" }, { path: "a", bytes: "file" }]),
    contract("fileDirectoryConflict"));
  assert.throws(() => scanZip([{ path: "a", bytes: "1234" }, { path: "b", bytes: "5678" }],
    limits({ maxTotalBytes: 6 })), contract("archiveBomb"));
});

test("nested TGZ and TAR enforce remaining total budget before expansion or payload copy", () => {
  const nested = tgz([{ path: "leaf.bin", bytes: Buffer.alloc(4096) }]);
  assert.ok(nested.length < 1102);
  const padding = Buffer.alloc(1102 - nested.length);
  assert.throws(() => scanZip([
    { path: "padding.bin", bytes: padding },
    { path: "nested.tgz", bytes: nested },
  ], limits({ maxTotalBytes: 5000 })), contract("archiveBomb"));

  const nestedTar = tar([{ path: "leaf.bin", bytes: Buffer.alloc(4096) }]);
  assert.throws(() => scanZip([{ path: "nested.tar", bytes: nestedTar }],
    limits({ maxTotalBytes: nestedTar.length + 4095 })), contract("archiveBomb"));

  const leaf = Buffer.alloc(4096);
  leaf[0] = 1;
  leaf[1] = 2;
  const siblingTgz = tgz([{ path: "leaf.bin", bytes: leaf }]);
  assert.equal(siblingTgz.length, 102);
  const nestedEntry = { path: "nested.tgz", bytes: siblingTgz };
  const fillerEntry = { path: "filler.bin", bytes: Buffer.alloc(6800) };
  for (const entries of [[nestedEntry, fillerEntry], [fillerEntry, nestedEntry]]) {
    assert.throws(() => scanZip(entries, limits({ maxTotalBytes: 7000 })),
      (error) => error instanceof ReleaseContractError && error.code === "archiveBomb"
        && error.message === "Gzip declared output exceeds the remaining total scan budget.");
  }
});

test("PE structure and binary content scanning reject fake MZ and hidden build/debug paths", () => {
  assert.throws(() => scanArtifact(Buffer.concat([Buffer.from("MZ/Users/alice/repo"), Buffer.alloc(100)]),
    { kind: "exe", path: "host.exe" }), contract("invalidPe"));
  const undersizedOptionalHeader = pe();
  undersizedOptionalHeader.writeUInt16LE(96, 84);
  assert.throws(() => scanArtifact(undersizedOptionalHeader,
    { kind: "exe", path: "host.exe" }), contract("invalidPe"));
  const utf16Path = Buffer.concat([Buffer.from("C:\\Users\\alice\\host.pdb", "utf16le"), Buffer.from([0xff])]);
  assert.throws(() => scanArtifact(pe(utf16Path), { kind: "exe", path: "host.exe" }),
    (error) => error instanceof ReleaseContractError
      && ["absoluteBuildPath", "debugArtifact"].includes(error.code));
  assert.throws(() => scanArtifact(pe(Buffer.from("symbols/app.pdb\0\xff", "latin1")),
    { kind: "exe", path: "host.exe" }), contract("debugArtifact"));
  for (const value of ["host.dSYM/Contents\0\xff", "host.dSYM\0\xff"]) {
    assert.throws(() => scanArtifact(pe(Buffer.from(value, "latin1")),
      { kind: "exe", path: "host.exe" }), contract("debugArtifact"));
  }
  assert.throws(() => scanZip([{ path: "native/host.exe", bytes: Buffer.from("MZnot-a-pe") }]),
    contract("invalidPe"));
});

test("indexed source maps, RAR5, suspicious compression, and V7 TAR are detected recursively", () => {
  const indexedMap = JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 },
    map: { version: 3, sourcesContent: ["hidden"] } }] });
  assert.throws(() => scanZip([{ path: "dist/index.js.map", bytes: indexedMap }]),
    contract("embeddedSources"));
  for (const suffix of [Buffer.from([0]), Buffer.from([0xff])]) {
    const malformedMap = Buffer.concat([Buffer.from('{"version":3}'), suffix]);
    assert.throws(() => scanZip([{ path: "dist/malformed.js.map", bytes: malformedMap }]),
      contract("invalidSourceMap"));
  }
  assert.throws(() => scanZip([{ path: "asset.bin", bytes: Buffer.from("526172211a070100", "hex") }]),
    contract("unknownContainer"));
  assert.throws(() => scanZip([{ path: "asset.bin", bytes: Buffer.from("fd377a585a00", "hex") }]),
    contract("unknownContainer"));
  const v7 = tar([{ path: "package/file", bytes: "v7" }], { ustar: false });
  const receipt = scanZip([{ path: "asset.bin", bytes: v7 }]);
  assert.ok(receipt.inventory.some((entry) => entry.path === "asset.bin!/package/file"));
});

function scanZip(entries, scanLimits = defaultScanLimits) {
  return scanArtifact(zip(entries), { kind: "zip", path: "release.zip", limits: scanLimits });
}

function limits(overrides) {
  return { ...defaultScanLimits, ...overrides };
}

function contract(code) {
  return (error) => error instanceof ReleaseContractError && error.code === code;
}

function withHiddenLocalBytes(bytes) {
  const endOffset = bytes.length - 22;
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const hidden = Buffer.alloc(30);
  hidden.writeUInt32LE(0x04034b50, 0);
  const result = Buffer.concat([
    bytes.subarray(0, centralOffset), hidden, bytes.subarray(centralOffset, endOffset),
    bytes.subarray(endOffset),
  ]);
  result.writeUInt32LE(centralOffset + hidden.length, result.length - 22 + 16);
  return result;
}
