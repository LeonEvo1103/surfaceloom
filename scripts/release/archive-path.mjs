import { fail } from "./shape.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const containerExtension = /\.(?:zip|tgz|gz|tar|7z|rar)$/iu;

export function safeArchivePath(input, { directory = false } = {}) {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")
      || input.includes("\\") || input !== input.normalize("NFC")) {
    fail("unsafeArchivePath", "Archive entry path is not canonical UTF-8/NFC.");
  }
  const value = directory && input.endsWith("/") ? input.slice(0, -1) : input;
  if (value.length === 0 || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) {
    fail("absoluteArchivePath", `Archive entry path is absolute: ${input}`);
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      fail("zipSlip", `Archive entry path escapes or aliases its root: ${input}`);
    }
    if (segment.includes(":")) fail("alternateDataStream", `Archive entry contains an ADS path: ${input}`);
    if (windowsReserved.test(segment) || /[ .]$/u.test(segment)) {
      fail("platformPathAlias", `Archive entry aliases a Windows device/path: ${input}`);
    }
  }
  return value;
}

export function assertPathUnique(path, paths, foldedPaths) {
  if (paths.has(path)) fail("duplicateArchivePath", `Archive contains duplicate path ${path}.`);
  const folded = path.toLocaleLowerCase("en-US");
  if (foldedPaths.has(folded)) fail("caseCollision", `Archive paths collide by case: ${path}.`);
  paths.add(path);
  foldedPaths.add(folded);
}

export function assertArchiveTreePath(path, directory, tree) {
  const segments = path.toLocaleLowerCase("en-US").split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join("/");
    if (tree.files.has(ancestor)) fail("fileDirectoryConflict", `${path} descends from file ${ancestor}.`);
    tree.directories.add(ancestor);
  }
  const folded = segments.join("/");
  if (directory) {
    if (tree.files.has(folded)) fail("fileDirectoryConflict", `${path} is both a file and directory.`);
    tree.directories.add(folded);
  } else {
    if (tree.directories.has(folded)) fail("fileDirectoryConflict", `${path} replaces a directory.`);
    tree.files.add(folded);
  }
}

export function assertReleaseContent(path, bytes) {
  if (/(?:^|\/)(?:[^/]+\.pdb$|[^/]+\.dSYM(?:\/|$)|[^/]+\.debug$)/iu.test(path)) {
    fail("debugArtifact", `Release contains debug artifact ${path}.`);
  }
  const raw = Buffer.from(bytes).toString("latin1");
  const nulCollapsed = raw.replaceAll("\0", "");
  if (/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|file:\/\/\/)/iu.test(raw)
      || /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|file:\/\/\/)/iu.test(nulCollapsed)) {
    fail("absoluteBuildPath", `Release file ${path} leaks an absolute build path.`);
  }
  const debugPath = /(?:\.pdb|\.debug)(?:\0|$|[^A-Za-z0-9_])|\.dSYM(?:[\/\\]|\0|$|[^A-Za-z0-9_])/iu;
  const collapsedDebugPath = /(?:\.pdb|\.debug)(?:$|[^A-Za-z0-9_])|\.dSYM(?:[\/\\]|$|[^A-Za-z0-9_])/iu;
  if (debugPath.test(raw) || collapsedDebugPath.test(nulCollapsed)) {
    fail("debugArtifact", `Release file ${path} embeds a debug-symbol path.`);
  }
  const sourceMap = /\.map$/iu.test(path);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch {
    if (sourceMap) fail("invalidSourceMap", `Source map ${path} must be strict UTF-8 JSON.`);
    return;
  }
  if (sourceMap) {
    let map;
    try { map = parseStrictJson(text); }
    catch { fail("invalidSourceMap", `Source map ${path} is invalid JSON.`); }
    if (map === null || typeof map !== "object" || Array.isArray(map)) {
      fail("invalidSourceMap", `Source map ${path} must be an object.`);
    }
    if (containsSourcesContent(map)) fail("embeddedSources", `Source map ${path} embeds sourcesContent.`);
  }
}

export function assertExtensionMatchesMagic(path, format) {
  if (!containerExtension.test(path)) return;
  const expected = /\.zip$/iu.test(path) ? "zip"
    : /\.(?:tgz|gz)$/iu.test(path) ? "gzip"
      : /\.tar$/iu.test(path) ? "tar" : "unsupported";
  if (expected === "unsupported") fail("unknownContainer", `Unsupported nested container ${path}.`);
  if (format !== expected) fail("containerMagicMismatch", `Container extension and magic disagree for ${path}.`);
}

export function detectFormat(bytes) {
  if (bytes.length >= 4) {
    const magic = bytes.readUInt32LE(0);
    if (magic === 0x04034b50 || magic === 0x06054b50 || magic === 0x08074b50) return "zip";
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic)) return "macho";
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return "pe";
  if (bytes.length >= 6 && bytes.subarray(0, 6).equals(Buffer.from("377abcaf271c", "hex"))) return "unsupported";
  if (bytes.length >= 7 && bytes.subarray(0, 7).equals(Buffer.from("526172211a0700", "hex"))) return "unsupported";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("526172211a070100", "hex"))) return "unsupported";
  if (bytes.length >= 6 && bytes.subarray(0, 6).equals(Buffer.from("fd377a585a00", "hex"))) return "unsupported";
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from("28b52ffd", "hex"))) return "unsupported";
  if (bytes.length >= 4 && bytes.subarray(0, 3).toString("ascii") === "BZh") return "unsupported";
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "MSCF") return "unsupported";
  if (bytes.length >= 262 && bytes.subarray(257, 262).toString("ascii") === "ustar") return "tar";
  if (looksLikeV7Tar(bytes)) return "tar";
  return "file";
}

function containsSourcesContent(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value) && Object.hasOwn(value, "sourcesContent")) return true;
  return Object.values(value).some((entry) => containsSourcesContent(entry, seen));
}

function looksLikeV7Tar(bytes) {
  if (bytes.length < 1536 || bytes.length % 512 !== 0) return false;
  const header = bytes.subarray(0, 512);
  if (header.every((byte) => byte === 0)) return false;
  const checksumText = header.subarray(148, 156).toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/u.test(checksumText)) return false;
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index];
  return sum === Number.parseInt(checksumText, 8);
}
