import { inflateRawSync } from "node:zlib";
import { assertArchiveTreePath, assertPathUnique, safeArchivePath } from "./archive-path.mjs";
import { fail } from "./shape.mjs";

export function readZipEntries(input, limits, remainingEntries, remainingTotalBytes = limits.maxTotalBytes) {
  const bytes = Buffer.from(input);
  const eocd = findEndRecord(bytes);
  const disk = u16(bytes, eocd + 4);
  const centralDisk = u16(bytes, eocd + 6);
  const diskEntries = u16(bytes, eocd + 8);
  const entryCount = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  const commentLength = u16(bytes, eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount
      || entryCount > remainingEntries || eocd + 22 + commentLength !== bytes.length
      || centralOffset + centralSize !== eocd) {
    fail("unsupportedZip", "ZIP64, split, excessive, trailing, or inconsistent ZIP is rejected.");
  }
  const paths = new Set();
  const folded = new Set();
  const entries = [];
  const localRanges = [];
  const tree = { files: new Set(), directories: new Set() };
  let declaredTotal = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    bounds(bytes, cursor, 46);
    if (u32(bytes, cursor) !== 0x02014b50) fail("invalidZip", "ZIP central directory is malformed.");
    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    const crc = u32(bytes, cursor + 16);
    const compressedSize = u32(bytes, cursor + 20);
    const size = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const entryCommentLength = u16(bytes, cursor + 32);
    const diskStart = u16(bytes, cursor + 34);
    const external = u32(bytes, cursor + 38);
    const localOffset = u32(bytes, cursor + 42);
    bounds(bytes, cursor + 46, nameLength + extraLength + entryCommentLength);
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeName(rawName, flags);
    const directory = name.endsWith("/");
    const canonical = safeArchivePath(name, { directory });
    assertPathUnique(canonical, paths, folded);
    assertArchiveTreePath(canonical, directory, tree);
    if ((flags & 1) !== 0) fail("encryptedArchive", `Encrypted ZIP entry ${canonical} is rejected.`);
    if (flags !== 0x800) fail("unsupportedZipFlags", `ZIP entry ${canonical} uses unsupported flags.`);
    if (diskStart !== 0) fail("unsupportedZip", "Split ZIP entries are rejected.");
    const mode = (external >>> 16) & 0xffff;
    const unixType = mode & 0o170000;
    if (unixType === 0o120000) fail("symbolicLink", `ZIP symlink ${canonical} is rejected.`);
    if (mode !== 0 && unixType !== (directory ? 0o040000 : 0o100000)) {
      fail("unknownUnixType", `ZIP entry ${canonical} has an unsupported Unix file type.`);
    }
    if ((external & 0x400) !== 0) fail("reparsePoint", `ZIP reparse entry ${canonical} is rejected.`);
    if (directory && (size !== 0 || compressedSize !== 0)) {
      fail("invalidZip", `ZIP directory ${canonical} must not contain bytes.`);
    }
    if (size > limits.maxEntryBytes) fail("archiveBomb", `ZIP entry ${canonical} exceeds size limit.`);
    declaredTotal += size;
    if (declaredTotal > remainingTotalBytes) {
      fail("archiveBomb", "ZIP declared output exceeds the remaining total scan budget.");
    }
    const ratio = compressedSize === 0 ? (size === 0 ? 1 : Infinity) : size / compressedSize;
    if (ratio > limits.maxCompressionRatio) fail("archiveBomb", `ZIP entry ${canonical} exceeds ratio limit.`);
    const local = localPayload(bytes, localOffset, name, flags, method, compressedSize, size, crc, centralOffset);
    if (localRanges.some(([start, end]) => localOffset < end && local.end > start)) {
      fail("overlappingArchiveEntry", `ZIP entry ${canonical} overlaps another local entry.`);
    }
    localRanges.push([localOffset, local.end]);
    const payload = local.output;
    if (crc32(payload) !== crc) fail("invalidZip", `ZIP entry ${canonical} has a bad CRC.`);
    if (!directory) entries.push(Object.freeze({ path: canonical, bytes: payload }));
    cursor += 46 + nameLength + extraLength + entryCommentLength;
  }
  if (cursor !== centralOffset + centralSize) fail("invalidZip", "ZIP central directory size is inconsistent.");
  localRanges.sort((left, right) => left[0] - right[0]);
  let covered = 0;
  for (const [start, end] of localRanges) {
    if (start !== covered) fail("hiddenLocalHeader", "ZIP local-header region is not exactly covered by central entries.");
    covered = end;
  }
  if (covered !== centralOffset) fail("hiddenLocalHeader", "ZIP contains unreferenced local-header bytes.");
  return entries;
}

function localPayload(bytes, offset, expectedName, centralFlags, method, compressedSize, size, crc, centralOffset) {
  bounds(bytes, offset, 30);
  if (u32(bytes, offset) !== 0x04034b50) fail("invalidZip", "ZIP local header is missing.");
  const flags = u16(bytes, offset + 6);
  const localMethod = u16(bytes, offset + 8);
  const localCrc = u32(bytes, offset + 14);
  const localCompressedSize = u32(bytes, offset + 18);
  const localSize = u32(bytes, offset + 22);
  const nameLength = u16(bytes, offset + 26);
  const extraLength = u16(bytes, offset + 28);
  bounds(bytes, offset + 30, nameLength + extraLength + compressedSize);
  const name = decodeName(bytes.subarray(offset + 30, offset + 30 + nameLength), flags);
  if (name !== expectedName || flags !== centralFlags || localMethod !== method
      || localCrc !== crc
      || localCompressedSize !== compressedSize || localSize !== size) {
    fail("invalidZip", "ZIP local and central headers disagree.");
  }
  const start = offset + 30 + nameLength + extraLength;
  const end = start + compressedSize;
  if (offset >= centralOffset || end > centralOffset) {
    fail("overlappingArchiveEntry", `ZIP entry ${expectedName} overlaps its central directory.`);
  }
  const compressed = bytes.subarray(start, start + compressedSize);
  let output;
  if (method === 0) output = Buffer.from(compressed);
  else if (method === 8) {
    try { output = inflateRawSync(compressed, { maxOutputLength: size + 1 }); }
    catch { fail("invalidZip", `ZIP deflate payload ${name} is invalid.`); }
  } else fail("unknownCompression", `ZIP compression method ${method} is unsupported.`);
  if (output.length !== size) fail("invalidZip", `ZIP entry ${name} length is inconsistent.`);
  return { output, end };
}

function findEndRecord(bytes) {
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (u32(bytes, offset) === 0x06054b50) return offset;
  }
  fail("invalidZip", "ZIP end record is missing.");
}

function decodeName(bytes, flags) {
  if ((flags & 0x800) === 0) fail("nonUtf8Path", "ZIP entries must declare UTF-8 names.");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("nonUtf8Path", "ZIP entry name is not valid UTF-8."); }
}

function bounds(bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0
      || length < 0 || offset + length > bytes.length) fail("truncatedArchive", "ZIP structure is truncated.");
}
const u16 = (bytes, offset) => { bounds(bytes, offset, 2); return bytes.readUInt16LE(offset); };
const u32 = (bytes, offset) => { bounds(bytes, offset, 4); return bytes.readUInt32LE(offset); };

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
