import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export const generatedSourceDirectoryNames = Object.freeze([
  ".build",
  ".git",
  "artifacts",
  "bin",
  "dist",
  "node_modules",
  "obj",
]);

/** Recursively discovers regular files without following repository symlinks. */
export async function findSourceTreeFiles(
  directory,
  predicate,
  {
    allowMissing = false,
    ignoredDirectoryNames = generatedSourceDirectoryNames,
  } = {},
) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new Error("The source-tree root must be an absolute path.");
  }
  if (typeof predicate !== "function") throw new TypeError("A source-tree predicate is required.");
  const ignored = new Set(ignoredDirectoryNames);
  return walk(directory, directory, predicate, ignored, allowMissing);
}

/** Lists direct child directories under the same no-symlink source-tree policy. */
export async function readSourceTreeDirectories(
  directory,
  {
    allowMissing = false,
    ignoreHidden = false,
    ignoredDirectoryNames = generatedSourceDirectoryNames,
  } = {},
) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new Error("The source-tree root must be an absolute path.");
  }
  const ignored = new Set(ignoredDirectoryNames);
  const entries = await readDirectoryEntries(directory, directory, allowMissing);
  if (entries === undefined) return [];
  const directories = [];
  for (const entry of entries) {
    if ((ignoreHidden && entry.name.startsWith(".")) || ignored.has(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw symlinkError(directory, candidate);
    if (entry.isDirectory()) directories.push(candidate);
  }
  return directories;
}

async function walk(directory, relativeRoot, predicate, ignored, allowMissing) {
  const entries = await readDirectoryEntries(directory, relativeRoot, allowMissing);
  if (entries === undefined) return [];
  const files = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw symlinkError(relativeRoot, candidate);
    if (entry.isDirectory()) {
      files.push(...await walk(candidate, relativeRoot, predicate, ignored, false));
    } else if (entry.isFile()) {
      const relativePath = path.relative(relativeRoot, candidate);
      if (predicate(relativePath, entry.name)) files.push(candidate);
    }
  }
  return files;
}

async function readDirectoryEntries(directory, relativeRoot, allowMissing) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return [];
    throw error;
  }
  if (metadata.isSymbolicLink()) throw symlinkError(relativeRoot, directory);
  if (!metadata.isDirectory()) throw new Error(`Source-tree root is not a directory: ${directory}`);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  return entries;
}

function symlinkError(root, candidate) {
  return new Error(
    `Symbolic links are not allowed in source trees: ${path.relative(root, candidate) || "."}`,
  );
}
