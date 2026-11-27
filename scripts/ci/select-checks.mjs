#!/usr/bin/env node

// Decides which Contract CI checks a change set needs. The rules live here, not
// in workflow expressions, so scripts/tests/ci/select-checks.test.mjs can pin them.
// Anything this table does not recognise, or cannot parse, runs every check.

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const CHECKS = Object.freeze([
  "swift",
  "windows_host",
  "artifact_release",
  "typescript",
  "framework_p1",
  "clipboard_transfer",
]);

const ALL = "all";
const SWIFT = ["swift"];
const TYPESCRIPT = ["typescript"];
const NONE = [];

// Ordered: the first matching rule classifies the path. Rules match case-insensitively
// because the macOS and Windows checkouts fold case: a case variant lands on the real file.
// The repository-wide guards (publication audit, PowerShell encoding and symlink scan)
// run on every change in the TypeScript job, so this table only routes the heavy checks.
const RULES = Object.freeze([
  // Checkout attributes at any depth rewrite the bytes every job checks out.
  [/(?:^|\/)\.gitattributes$/iu, ALL],
  // Separate Pages workflow; it is not part of Contract CI.
  [/^\.github\/workflows\/pages\.yml$/iu, NONE],
  // The workflow itself and this selector change how every check runs.
  [/^\.github\//iu, ALL],
  [/^scripts\/ci\//iu, ALL],
  // Golden protocol vectors are read by Swift (NativeSchemaTests), the C# contract
  // tests (csproj Content include) and the TypeScript native package.
  [/^packages\/native\/vectors\//iu, ["swift", "windows_host", "typescript"]],
  [/^packages\//iu, TYPESCRIPT],
  // Product contracts are discovered by scripts/lib/repository-contract-discovery.mjs.
  [/^projects\//iu, TYPESCRIPT],
  [/^examples\//iu, ["framework_p1"]],
  [/^(?:Sources|Tests)\//iu, SWIFT],
  [/^Package\.(?:swift|resolved)$/iu, SWIFT],
  [/^native\/windows-host\//iu, ["windows_host"]],
  // Neither fixture is built or tested by Contract CI; only the always-on guards scan them.
  [/^native\/(?:macos|windows)-fixture\//iu, NONE],
  // Scenario templates are not compiled; check-architecture.sh (always on) scans them.
  [/^Templates\//iu, NONE],
  [/^scripts\/run-swift-tests\.sh$/iu, SWIFT],
  // Run by run-swift-tests.sh on macOS and covered by scripts/tests/check-architecture*.test.mjs.
  [/^scripts\/check-architecture\.sh$/iu, ["swift", "typescript"]],
  [/^scripts\/clipboard-transfer\//iu, ["clipboard_transfer"]],
  // test-artifact-release.ps1 inputs; artifact-release-layout.test.mjs also reads them.
  [/^scripts\/(?:test-artifact-release\.ps1$|lib\/ArtifactRelease(?:\.psm1$|\/)|tests\/artifact-release\/)/iu,
    ["artifact_release", "typescript"]],
  [/^scripts\/(?:run-framework-p1-tests\.sh$|service-packed-consumer\/)/iu, ["framework_p1"]],
  // Remaining scripts feed run-typescript-tests.sh: audit, package helpers, lib, release, tests.
  [/^scripts\//iu, TYPESCRIPT],
  // Copied into every package dist and read by the release contract fixtures.
  [/^LICENSE$/iu, TYPESCRIPT],
  // Schemas parsed by scripts/tests/release-contract/strict-json.test.mjs.
  [/^docs\/release\//iu, TYPESCRIPT],
  [/^(?:docs|website)\//iu, NONE],
  [/^(?:README|CONTRIBUTING|SECURITY|AGENTS)\.md$/iu, NONE],
]);

export function everyCheck(reason) {
  return finish(new Set(CHECKS), reason);
}

/** Maps repository-relative POSIX paths to the checks they require. */
export function selectChecks(files) {
  if (!Array.isArray(files)) return everyCheck("change list is not an array");
  if (files.length === 0) return everyCheck("change list is empty");
  const selected = new Set();
  for (const file of files) {
    const problem = invalidPath(file);
    if (problem !== undefined) return everyCheck(problem);
    const checks = classify(file);
    if (checks === ALL) return everyCheck(`${file} affects every check`);
    for (const check of checks) selected.add(check);
  }
  return finish(selected, `${files.length} changed path(s) classified`);
}

function classify(file) {
  for (const [pattern, checks] of RULES) {
    if (pattern.test(file)) return checks;
  }
  return ALL;
}

// A name the macOS or Windows checkout cannot materialise would only fail there, so
// such a path never narrows the run.
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu;

function invalidPath(file) {
  if (typeof file !== "string" || file === "") return "change list contains an empty or non-string path";
  if (/[\u0000-\u001f\u007f<>:"|?*\\\ufffd]/u.test(file)) {
    return "change list contains a path with characters some checkouts reject";
  }
  if (file !== file.normalize("NFC")) return "change list contains a path that is not NFC";
  if (file.startsWith("/")) return "change list contains an absolute path";
  const segments = file.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "change list contains a non-canonical path";
  }
  if (segments.some((segment) => /[ .]$/u.test(segment) || WINDOWS_RESERVED_SEGMENT.test(segment))) {
    return "change list contains a path Windows cannot check out";
  }
  return undefined;
}

function finish(selected, reason) {
  // The Ubuntu framework P1 run includes the full run-typescript-tests.sh suite.
  if (selected.has("typescript")) selected.add("framework_p1");
  // Policy, not a file dependency: host changes also run the seconds-long artifact release
  // contracts, which package the host for release.
  if (selected.has("windows_host")) selected.add("artifact_release");
  const result = Object.fromEntries(CHECKS.map((check) => [check, selected.has(check)]));
  result.windows = result.windows_host || result.artifact_release || result.typescript
    || result.clipboard_transfer;
  result.reason = reason;
  return Object.freeze(result);
}

/** Renders a selection as GitHub step outputs (one key=value per line). */
export function formatOutputs(selection) {
  const lines = [...CHECKS, "windows"].map((key) => `${key}=${selection[key] ? "true" : "false"}`);
  lines.push(`reason=${String(selection.reason).replace(/[\r\n]+/gu, " ")}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Parses `git diff --name-only -z` output; a trailing NUL terminates the last record.
 * Accepts raw bytes so a name that is not valid UTF-8 surfaces as U+FFFD (and runs every check).
 */
export function parseNulSeparated(input) {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { ignoreBOM: true }).decode(input);
  if (text === "") return [];
  const records = text.split("\0");
  if (records.at(-1) === "") records.pop();
  return records;
}

// A full run needs no selector: the workflow treats any check without an explicit "false"
// output as required, so only a scoped pull request diff is ever passed here.
async function main(argv) {
  if (argv[0] === "--files-from" && argv.length === 2) {
    return formatOutputs(selectChecks(parseNulSeparated(await readFile(argv[1]))));
  }
  throw new Error("Usage: select-checks.mjs --files-from <nul-separated-list>");
}

// The loader resolves symlinks in import.meta.url, so compare against the resolved argv path.
if (process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  process.stdout.write(await main(process.argv.slice(2)));
}
