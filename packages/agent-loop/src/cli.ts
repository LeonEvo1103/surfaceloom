#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { importAgentLoop } from "./adapter.js";
import { discoverAgentLoopInputs } from "./discover.js";
import { maximumTraceInputBytes } from "./limits.js";
import { renderAgentLoopHTML } from "./render-html.js";
import { maximumAgentLoopListCases, renderAgentLoopListHTML } from "./render-list-html.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const discovery = await discoverAgentLoopInputs(args.inputDirectories);
  const explicitPaths = new Set(args.inputs.map((inputPath) => path.resolve(inputPath)));
  const inputPaths = [...new Set([...explicitPaths, ...discovery.files])];
  if (inputPaths.length > maximumAgentLoopListCases) throw new Error(`Agent-loop list exceeds ${maximumAgentLoopListCases} cases.`);
  const listMode = args.inputDirectories.length > 0 || inputPaths.length > 1;
  const traces = [];
  let skippedCandidates = 0;
  for (const inputPath of inputPaths) {
    try {
      const inputInfo = await stat(inputPath);
      if (!inputInfo.isFile()) throw new Error(`Trace input must be a regular file: ${inputPath}`);
      if (inputInfo.size > maximumTraceInputBytes) throw new Error(`Trace input exceeds 32 MiB: ${inputPath}`);
      const input = await readFile(inputPath, "utf8");
      traces.push(importAgentLoop(input, {
        format: args.format,
        id: idFromPath(inputPath),
        ...(!listMode && args.title !== undefined
          ? { title: args.title }
          : { title: `${String(traces.length + 1).padStart(3, "0")} · ${titleFromPath(inputPath)}` }),
      }));
    } catch (error) {
      if (explicitPaths.has(inputPath)) throw error;
      skippedCandidates += 1;
    }
  }
  if (traces.length === 0) throw new Error("No recognized trace files were found.");
  const batchWarnings = [
    ...discovery.warnings,
    skippedCandidates === 0 ? "" : `Skipped ${skippedCandidates} candidate file${skippedCandidates === 1 ? "" : "s"} that could not be imported.`,
  ].filter(Boolean);
  const output = !listMode
    ? renderAgentLoopHTML(traces[0]!, { ...(args.title === undefined ? {} : { title: args.title }) })
    : renderAgentLoopListHTML(traces, { title: args.title ?? "Agent Loop Cases", warnings: batchWarnings });
  await writeFile(args.output, output, { encoding: "utf8", flag: args.force ? "w" : "wx" });
  if (listMode) process.stderr.write(`Imported ${traces.length} trace file${traces.length === 1 ? "" : "s"}; skipped ${skippedCandidates}.\n`);
  process.stdout.write(`${args.output}\n`);
}

interface Arguments { inputs: string[]; inputDirectories: string[]; output: string; format: string; title?: string; force: boolean; }

function parseArgs(values: readonly string[]): Arguments {
  const inputs: string[] = [];
  const inputDirectories: string[] = [];
  let output: string | undefined;
  let format = "auto";
  let title: string | undefined;
  let force = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--force") { force = true; continue; }
    const next = values[index + 1];
    if (next === undefined) usage();
    if (value === "--input") inputs.push(next);
    else if (value === "--input-dir") inputDirectories.push(next);
    else if (value === "--output") output = next;
    else if (value === "--format") format = next;
    else if (value === "--title") title = next;
    else usage();
    index += 1;
  }
  if ((inputs.length === 0 && inputDirectories.length === 0) || output === undefined) usage();
  return { inputs, inputDirectories, output, format, ...(title === undefined ? {} : { title }), force };
}

function usage(): never {
  throw new Error("Usage: surfaceloom-agent-loop (--input trace | --input-dir directory)... --output loop.html [--format auto|codex|surfaceloom] [--title text] [--force]");
}

function idFromPath(inputPath: string): string {
  const value = titleFromPath(inputPath).toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").replace(/^-+|-+$/g, "");
  return value || "agent-loop-case";
}

function titleFromPath(inputPath: string): string {
  return path.basename(inputPath)
    .replace(/(?:\.trace)?\.(?:jsonl|ndjson|json|trace)$/i, "")
    .replace(/^\d+[._-]?/, "")
    .replace(/[-_]+/g, " ")
    .trim() || "Agent Loop Case";
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Agent-loop rendering failed."}\n`);
  process.exitCode = 1;
});
