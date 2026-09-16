#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const historyMode = process.argv.includes("--history");
const revisionIndex = process.argv.indexOf("--revision");
const revision = revisionIndex === -1 ? undefined : process.argv[revisionIndex + 1];
if (revisionIndex !== -1 && (revision === undefined || revision.startsWith("--"))) {
  throw new Error("--revision requires one Git revision.");
}
if (revision !== undefined && !historyMode) throw new Error("--revision requires --history.");
const forbiddenTerms = (process.env.SURFACELOOM_FORBIDDEN_TERMS ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const maximumBytes = 5 * 1024 * 1024;
const findings = [];
const rules = [
  ["private-key", /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["provider-secret", /\b(?:sk-[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
];
const forbiddenExtensions = new Set([".env", ".har", ".key", ".mobileprovision", ".p12", ".pem", ".sqlite", ".trace"]);
let scannedItems = 0;

if (historyMode) await scanHistory();
else await scanWorkingTree();

const result = {
  mode: historyMode ? "history" : "working-tree",
  ...(revision === undefined ? {} : { revision }),
  scannedItems,
  findings: findings.slice(0, 100),
  truncatedFindings: Math.max(0, findings.length - 100),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (findings.length > 0) process.exitCode = 1;

async function scanWorkingTree() {
  const result = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "buffer" });
  const files = result.stdout.toString("utf8").split("\0").filter(Boolean);
  for (const relative of files) {
    try {
      const content = await readFile(path.join(root, relative));
      scan(relative, content);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function scanHistory() {
  const commits = await run("git", ["rev-list", revision ?? "--all"], { cwd: root });
  for (const commitId of commits.stdout.split("\n").filter(Boolean)) {
    const metadata = await run("git", ["show", "--no-patch", "--format=%an%n%ae%n%cn%n%ce%n%B", commitId], {
      cwd: root,
      encoding: "buffer",
    });
    scan(`<commit-metadata:${commitId.slice(0, 12)}>`, metadata.stdout);
  }
  const objects = await run("git", ["rev-list", "--objects", revision ?? "--all"], { cwd: root });
  const seen = new Set();
  for (const line of objects.stdout.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf(" ");
    const objectId = separator === -1 ? line : line.slice(0, separator);
    const relative = separator === -1 ? "<git-object>" : line.slice(separator + 1);
    if (seen.has(objectId)) continue;
    seen.add(objectId);
    const type = await run("git", ["cat-file", "-t", objectId], { cwd: root });
    if (type.stdout.trim() !== "blob") continue;
    const size = await run("git", ["cat-file", "-s", objectId], { cwd: root });
    if (Number(size.stdout.trim()) > maximumBytes) {
      findings.push({ rule: "oversized-blob", path: relative });
      continue;
    }
    const content = await run("git", ["cat-file", "blob", objectId], { cwd: root, encoding: "buffer", maxBuffer: maximumBytes + 1 });
    scan(relative, content.stdout);
  }
}

function scan(relative, content) {
  scannedItems += 1;
  const extension = path.extname(relative).toLowerCase();
  if (forbiddenExtensions.has(extension) || path.basename(relative).startsWith(".env")) {
    findings.push({ rule: "forbidden-file-type", path: relative });
  }
  if (content.length > maximumBytes) findings.push({ rule: "oversized-file", path: relative });
  if (content.includes(0)) {
    findings.push({ rule: "binary-file", path: relative });
    return;
  }
  const text = content.toString("utf8");
  for (const [rule, pattern] of rules) if (pattern.test(text)) findings.push({ rule, path: relative });
  forbiddenTerms.forEach((term, index) => {
    const normalizedTerm = term.toLocaleLowerCase("en-US");
    if (relative.toLocaleLowerCase("en-US").includes(normalizedTerm)
      || text.toLocaleLowerCase("en-US").includes(normalizedTerm)) {
      findings.push({ rule: `forbidden-term-${index + 1}`, path: relative });
    }
  });
}
