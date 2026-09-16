import { createHash, randomBytes } from "node:crypto";

export const PROTOCOL = "slm-clipboard-v1";
export const STATE_DIRECTORY = ".slm-clipboard-transfer";
export const DEFAULT_MAX_COMMAND_CHARS = 1_800;
export const DEFAULT_CHUNK_RAW_BYTES = 1_200;
// Clipboard transport is intentionally a small-artifact protocol. Keeping this
// bounded also caps sender memory while commands are materialized in an outbox.
export const MAX_TOTAL_BYTES = 67_108_864;
export const MAX_CHUNK_RAW_BYTES = 1_048_576;
export const MAX_CHUNKS = 100_000;

const SESSION_PATTERN = /^[a-f0-9]{32}$/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\..*)?$/iu;
const WINDOWS_ILLEGAL_CHARACTER = /[<>:"/\\|?*\u0000-\u001f]/u;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createSessionId() {
  return randomBytes(16).toString("hex");
}

export function validateSessionId(value) {
  if (typeof value !== "string" || !SESSION_PATTERN.test(value)) {
    throw protocolError("INVALID_SESSION_ID");
  }
  return value;
}

export function validateTargetName(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 240
    || value !== value.normalize("NFC")
    || value === "."
    || value === ".."
    || /[ .]$/u.test(value)
    || WINDOWS_ILLEGAL_CHARACTER.test(value)
    || WINDOWS_RESERVED_NAME.test(value)
    || value.toLowerCase() === STATE_DIRECTORY
    || value.toLowerCase().startsWith(".slm-clipboard-")
  ) {
    throw protocolError("INVALID_TARGET_NAME");
  }
  return value;
}

export function canonicalBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

export function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw protocolError("NON_CANONICAL_BASE64");
  }
  const decoded = Buffer.from(value, "base64");
  if (canonicalBase64(decoded) !== value) throw protocolError("NON_CANONICAL_BASE64");
  return decoded;
}

export function buildManifest({ sessionId, targetName, bytes, chunkRawBytes }) {
  validateSessionId(sessionId);
  validateTargetName(targetName);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_TOTAL_BYTES) throw protocolError("INVALID_INPUT");
  if (!Number.isSafeInteger(chunkRawBytes) || chunkRawBytes < 1 || chunkRawBytes > MAX_CHUNK_RAW_BYTES) {
    throw protocolError("INVALID_CHUNK_SIZE");
  }
  const chunkCount = bytes.length === 0 ? 0 : Math.ceil(bytes.length / chunkRawBytes);
  if (chunkCount > MAX_CHUNKS) throw protocolError("TOO_MANY_CHUNKS");
  return {
    protocol: PROTOCOL,
    sessionId,
    targetName,
    totalLength: bytes.length,
    fileSha256: sha256(bytes),
    chunkRawBytes,
    chunkCount,
  };
}

export function encodeManifest(manifest) {
  return Buffer.from(JSON.stringify(manifest), "utf8");
}

export function splitChunks(bytes, manifest) {
  const chunks = [];
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const raw = bytes.subarray(index * manifest.chunkRawBytes, (index + 1) * manifest.chunkRawBytes);
    chunks.push({
      index,
      rawLength: raw.length,
      sha256: sha256(raw),
      base64: canonicalBase64(raw),
    });
  }
  return chunks;
}

export function expectedChunkLength(manifest, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.chunkCount) {
    throw protocolError("INVALID_CHUNK_INDEX");
  }
  const remaining = manifest.totalLength - (index * manifest.chunkRawBytes);
  return Math.min(manifest.chunkRawBytes, remaining);
}

export function formatRanges(indices) {
  if (indices.length === 0) return "none";
  const sorted = [...new Set(indices)].sort((left, right) => left - right);
  const ranges = [];
  let start = sorted[0];
  let end = sorted[0];
  for (const index of sorted.slice(1)) {
    if (index === end + 1) {
      end = index;
      continue;
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    start = index;
    end = index;
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(",");
}

export function protocolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
