import { gunzipSync } from "node:zlib";
import { assertArchiveTreePath, assertPathUnique, safeArchivePath } from "./archive-path.mjs";
import { fail } from "./shape.mjs";

export function readTgzEntries(input, limits, remainingEntries,
  remainingTotalBytes = limits.maxTotalBytes) {
  const compressed = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (remainingTotalBytes <= 0) fail("archiveBomb", "Gzip has no remaining expansion budget.");
  if (compressed.length >= 4
      && compressed.readUInt32LE(compressed.length - 4) > remainingTotalBytes) {
    fail("archiveBomb", "Gzip declared output exceeds the remaining total scan budget.");
  }
  let bytes;
  try { bytes = gunzipSync(compressed, { maxOutputLength: remainingTotalBytes }); }
  catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      fail("archiveBomb", "Gzip output exceeds the remaining total scan budget.");
    }
    fail("invalidGzip", "Gzip payload is invalid.");
  }
  if (bytes.length / Math.max(1, compressed.length) > limits.maxCompressionRatio) {
    fail("archiveBomb", "Gzip container exceeds the compression-ratio limit.");
  }
  return readTarEntries(bytes, limits, remainingEntries, remainingTotalBytes);
}

export function readTarEntries(input, limits, remainingEntries,
  remainingTotalBytes = limits.maxTotalBytes) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const paths = new Set();
  const folded = new Set();
  const entries = [];
  let cursor = 0;
  let zeroBlocks = 0;
  let headerCount = 0;
  let declaredTotal = 0;
  const tree = { files: new Set(), directories: new Set() };
  while (cursor + 512 <= bytes.length) {
    const header = bytes.subarray(cursor, cursor + 512);
    cursor += 512;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks === 2) break;
      continue;
    }
    if (zeroBlocks !== 0) fail("invalidTar", "TAR has data after a zero block.");
    headerCount += 1;
    if (headerCount > remainingEntries) fail("archiveBomb", "TAR entry-count limit exceeded.");
    verifyChecksum(header);
    const name = text(header.subarray(0, 100));
    const prefix = text(header.subarray(345, 500));
    const rawPath = prefix.length === 0 ? name : `${prefix}/${name}`;
    const type = header[156];
    const directory = type === 0x35;
    const path = safeArchivePath(rawPath, { directory });
    assertPathUnique(path, paths, folded);
    assertArchiveTreePath(path, directory, tree);
    const size = octal(header.subarray(124, 136), "TAR size");
    if (type === 0x31) fail("hardLink", `TAR hardlink ${path} is rejected.`);
    if (type === 0x32) fail("symbolicLink", `TAR symlink ${path} is rejected.`);
    if (![0, 0x30, 0x35].includes(type)) fail("unknownTarType", `TAR entry type ${type} is rejected.`);
    if (directory && size !== 0) fail("invalidTar", `TAR directory ${path} has payload bytes.`);
    if (size > limits.maxEntryBytes) fail("archiveBomb", `TAR entry ${path} exceeds size limit.`);
    declaredTotal += size;
    if (declaredTotal > remainingTotalBytes) {
      fail("archiveBomb", "TAR declared output exceeds the remaining total scan budget.");
    }
    if (cursor + size > bytes.length) fail("truncatedArchive", `TAR entry ${path} is truncated.`);
    if (!directory) entries.push(Object.freeze({ path, bytes: Buffer.from(bytes.subarray(cursor, cursor + size)) }));
    cursor += Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks !== 2 || bytes.subarray(cursor).some((byte) => byte !== 0)) {
    fail("invalidTar", "TAR must end with two zero blocks and no trailing data.");
  }
  return entries;
}

function verifyChecksum(header) {
  const expected = octal(header.subarray(148, 156), "TAR checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) fail("invalidTar", "TAR header checksum does not match.");
}

function text(bytes) {
  const end = bytes.indexOf(0);
  const value = bytes.subarray(0, end < 0 ? bytes.length : end);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { fail("nonUtf8Path", "TAR entry name is not valid UTF-8."); }
}

function octal(bytes, label) {
  const value = text(bytes).trim();
  if (!/^[0-7]+$/u.test(value)) fail("invalidTar", `${label} is not canonical octal.`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) fail("invalidTar", `${label} is too large.`);
  return parsed;
}
