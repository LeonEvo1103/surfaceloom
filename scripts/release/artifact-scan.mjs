import { assertExtensionMatchesMagic, assertReleaseContent, detectFormat } from "./archive-path.mjs";
import { artifactKinds, defaultScanLimits, scanSchemaVersion } from "./constants.mjs";
import { canonicalInventoryDigest, digestRecord } from "./digest.mjs";
import { fail, integer, oneOf, record } from "./shape.mjs";
import { readTarEntries, readTgzEntries } from "./tar-scan.mjs";
import { readZipEntries } from "./zip-scan.mjs";
import { validatePortableExecutable } from "./pe-scan.mjs";

export function scanArtifact(input, options) {
  const settings = record(options, "scan options", ["kind", "path", "limits"], ["kind", "path"]);
  const kind = oneOf(settings.kind, artifactKinds, "artifact kind");
  const bytes = Buffer.from(input);
  const limits = scanLimits(settings.limits ?? defaultScanLimits);
  if (bytes.length === 0 || bytes.length > limits.maxArchiveBytes) {
    fail("archiveSize", "Artifact bytes are empty or exceed the archive-size limit.");
  }
  const format = detectFormat(bytes);
  const expected = kind === "tgz" ? "gzip" : kind === "exe" ? "pe" : "zip";
  if (format !== expected) fail("artifactMagic", `${kind} artifact has ${format} magic instead of ${expected}.`);
  const state = {
    inventory: [], entryCount: 0, totalBytes: 0, maxDepth: 0, limits,
    paths: new Set(), foldedPaths: new Set(),
  };
  if (format === "pe") {
    validatePortableExecutable(bytes);
    addEntry(state, "$self", bytes, 0, false);
  }
  else scanContainer(bytes, format, "", 0, state);
  if (state.entryCount === 0) fail("emptyArtifact", "Release artifact inventory must not be empty.");
  state.inventory.sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (kind === "app") {
    const roots = new Set(state.inventory.map((entry) => /^([^/]+\.app)\//u.exec(entry.path)?.[1])
      .filter((entry) => entry !== undefined));
    const root = [...roots][0];
    if (roots.size !== 1 || state.inventory.some((entry) => !entry.path.startsWith(`${root}/`))) {
      fail("invalidAppBundle", "An app artifact must contain exactly one top-level .app bundle.");
    }
  }
  const artifactDigest = digestRecord(bytes);
  return Object.freeze({
    schemaVersion: scanSchemaVersion,
    artifactDigest,
    byteLength: bytes.length,
    format,
    complete: true,
    limits,
    entryCount: state.entryCount,
    totalUncompressedBytes: state.totalBytes,
    maxDepth: state.maxDepth,
    inventoryDigest: canonicalInventoryDigest(state.inventory),
    inventory: Object.freeze(state.inventory),
  });
}

export function assertScanBindsPublishedBytes(receipt, bytes) {
  const published = Buffer.from(bytes);
  if (receipt.byteLength !== published.length
      || receipt.artifactDigest?.algorithm !== "sha256"
      || receipt.artifactDigest.value !== digestRecord(published).value
      || receipt.complete !== true) {
    fail("scanPublishMismatch", "Scanned bytes are not the bytes selected for publication.");
  }
}

function scanContainer(bytes, format, prefix, depth, state) {
  if (depth > state.limits.maxDepth) fail("archiveDepth", "Nested archive depth exceeds the scan limit.");
  if (bytes.length > state.limits.maxArchiveBytes) fail("archiveSize", "Nested archive exceeds the scan limit.");
  state.maxDepth = Math.max(state.maxDepth, depth);
  let entries;
  const remaining = state.limits.maxEntries - state.entryCount;
  if (format === "zip") entries = readZipEntries(bytes, state.limits, remaining,
    state.limits.maxTotalBytes - state.totalBytes);
  else if (format === "gzip") entries = readTgzEntries(bytes, state.limits, remaining,
    state.limits.maxTotalBytes - state.totalBytes);
  else if (format === "tar") entries = readTarEntries(bytes, state.limits, remaining,
    state.limits.maxTotalBytes - state.totalBytes);
  else fail("unknownContainer", `Unsupported container format ${format}.`);
  const nested = [];
  for (const entry of entries) {
    const path = prefix.length === 0 ? entry.path : `${prefix}!/${entry.path}`;
    addEntry(state, path, entry.bytes, depth, true);
    const nestedFormat = detectFormat(entry.bytes);
    assertExtensionMatchesMagic(entry.path, nestedFormat);
    if (nestedFormat === "zip" || nestedFormat === "gzip" || nestedFormat === "tar") {
      nested.push({ bytes: entry.bytes, format: nestedFormat, path });
    } else if (nestedFormat === "pe") {
      validatePortableExecutable(entry.bytes);
    } else if (nestedFormat === "unsupported") {
      fail("unknownContainer", `Unsupported nested container ${path}.`);
    }
  }
  for (const child of nested) {
    scanContainer(child.bytes, child.format, child.path, depth + 1, state);
  }
}

function addEntry(state, path, bytes, depth, inspectContent) {
  const folded = path.toLocaleLowerCase("en-US");
  if (state.paths.has(path)) fail("duplicateArchivePath", `Recursive inventory duplicates ${path}.`);
  if (state.foldedPaths.has(folded)) fail("caseCollision", `Recursive inventory collides by case at ${path}.`);
  state.paths.add(path);
  state.foldedPaths.add(folded);
  state.entryCount += 1;
  state.totalBytes += bytes.length;
  if (state.entryCount > state.limits.maxEntries || state.totalBytes > state.limits.maxTotalBytes) {
    fail("archiveBomb", "Archive exceeds count or total-size limits.");
  }
  if (inspectContent) assertReleaseContent(path, bytes);
  state.inventory.push(Object.freeze({ path, byteLength: bytes.length, digest: digestRecord(bytes) }));
  state.maxDepth = Math.max(state.maxDepth, depth);
}

function scanLimits(value) {
  const input = record(value, "scan limits", Object.keys(defaultScanLimits));
  const output = {};
  for (const key of Object.keys(defaultScanLimits)) output[key] = integer(input[key], `scan limits.${key}`, { min: 1 });
  return Object.freeze(output);
}
