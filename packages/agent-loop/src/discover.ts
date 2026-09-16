import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { maximumAgentLoopListCases } from "./render-list-html.js";

const maximumScannedEntries = 200_000;
const maximumDepth = 32;
const ignoredDirectories = new Set([".git", ".hg", ".svn", "node_modules", "dist", "build", ".build", "coverage"]);

export interface AgentLoopDiscoveryResult {
  readonly files: readonly string[];
  readonly warnings: readonly string[];
}

export async function discoverAgentLoopInputs(roots: readonly string[]): Promise<AgentLoopDiscoveryResult> {
  const files = new Set<string>();
  let scannedEntries = 0;
  let skippedSymbolicLinks = 0;
  let unreadableDirectories = 0;

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maximumDepth) throw new Error(`Trace discovery exceeds maximum depth ${maximumDepth}.`);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      unreadableDirectories += 1;
      return;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > maximumScannedEntries) throw new Error(`Trace discovery exceeds ${maximumScannedEntries} filesystem entries.`);
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedSymbolicLinks += 1;
      } else if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
        await walk(candidate, depth + 1);
      } else if (entry.isFile() && isTraceCandidate(entry.name)) {
        files.add(candidate);
        if (files.size > maximumAgentLoopListCases) {
          throw new Error(`Trace discovery exceeds ${maximumAgentLoopListCases} candidate files.`);
        }
      }
    }
  }

  for (const root of roots) {
    const absolute = path.resolve(root);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error("Trace discovery root must not be a symbolic link.");
    if (!info.isDirectory()) throw new Error("Trace discovery root must be a directory.");
    await walk(absolute, 0);
  }

  const warnings = [
    skippedSymbolicLinks === 0 ? "" : `Skipped ${skippedSymbolicLinks} symbolic link${skippedSymbolicLinks === 1 ? "" : "s"} during discovery.`,
    unreadableDirectories === 0 ? "" : `Skipped ${unreadableDirectories} unreadable director${unreadableDirectories === 1 ? "y" : "ies"} during discovery.`,
  ].filter(Boolean);
  return Object.freeze({
    files: Object.freeze([...files].sort()),
    warnings: Object.freeze(warnings),
  });
}

function isTraceCandidate(name: string): boolean {
  if (!/\.(?:json|jsonl|ndjson|trace)$/i.test(name)) return false;
  const stem = name.replace(/\.[^.]+$/, "");
  return /(?:^|[._-])(?:trace|rollout)(?:[._-]|$)/i.test(stem);
}
