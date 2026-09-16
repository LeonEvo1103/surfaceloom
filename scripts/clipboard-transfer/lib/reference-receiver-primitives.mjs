import { lstat, readFile } from "node:fs/promises";

import { protocolError } from "./protocol.mjs";

export function chunkFileName(index) {
  return `${String(index).padStart(8, "0")}.chunk.json`;
}

export async function exists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readOptional(candidate) {
  if (!(await exists(candidate))) return null;
  await assertPlain(candidate, false);
  return readFile(candidate);
}

export async function readOptionalRegular(candidate) {
  return readOptional(candidate);
}

export async function assertPlain(candidate, directory) {
  const stat = await lstat(candidate);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw protocolError("REPARSE_REJECTED");
  }
}

const sessionLocks = new Map();

export async function withSessionLock(key, operation) {
  const previous = sessionLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  sessionLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sessionLocks.get(key) === current) sessionLocks.delete(key);
  }
}
