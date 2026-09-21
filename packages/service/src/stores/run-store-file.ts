import { readFile } from "node:fs/promises";

import type { StoredRunRecord } from "./contracts.js";
import { StoreConflictError, StoreCorruptionError } from "./contracts.js";
import { writeAtomicFile } from "./atomic-file.js";

interface StoreFile {
  readonly schemaVersion: "surfaceloom.run-store/v1";
  readonly runs: unknown[];
}

export async function readRunStoreFile(
  target: string,
  maxBytes: number,
): Promise<readonly unknown[]> {
  let input: string;
  try {
    input = await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (Buffer.byteLength(input, "utf8") > maxBytes) {
    throw new StoreCorruptionError("Run store is too large.");
  }
  let value: StoreFile;
  try {
    value = JSON.parse(input) as StoreFile;
  } catch (cause) {
    throw new StoreCorruptionError("Run store JSON is invalid.", { cause });
  }
  if (value.schemaVersion !== "surfaceloom.run-store/v1" || !Array.isArray(value.runs)) {
    throw new StoreCorruptionError("Run store header is invalid.");
  }
  return value.runs;
}

export async function writeRunStoreFile(
  target: string,
  runs: readonly StoredRunRecord[],
  maxBytes: number,
): Promise<void> {
  const serialized = `${JSON.stringify({ schemaVersion: "surfaceloom.run-store/v1", runs })}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new StoreConflictError("Run store exceeds the configured byte limit.");
  }
  await writeAtomicFile(target, serialized);
}
