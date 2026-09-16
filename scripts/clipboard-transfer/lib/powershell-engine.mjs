import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

import { canonicalBase64, sha256 } from "./protocol.mjs";

const engineUrl = new URL("../powershell/receiver.ps1", import.meta.url);
const engineBytes = await readFile(engineUrl);

export const engineHash = sha256(engineBytes);
export const engineFileName = `engine-${engineHash}.ps1`;
export const compressedEngine = gzipSync(engineBytes, { level: 9 });
export const compressedEngineHash = sha256(compressedEngine);
export const engineParts = [];

for (let offset = 0; offset < compressedEngine.length; offset += 120) {
  const bytes = compressedEngine.subarray(offset, offset + 120);
  engineParts.push({
    index: engineParts.length,
    rawLength: bytes.length,
    sha256: sha256(bytes),
    base64: canonicalBase64(bytes),
  });
}

export const engineManifestBytes = Buffer.from(JSON.stringify({
  e: engineHash,
  z: compressedEngineHash,
  l: compressedEngine.length,
  n: engineParts.length,
}), "utf8");
export const engineManifestHash = sha256(engineManifestBytes);
