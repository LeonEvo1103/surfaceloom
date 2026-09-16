#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const packageDirectory = path.join(root, "packages/agent-loop");
const temporary = await mkdtemp(path.join(tmpdir(), "surfaceloom-external-adapter-"));

try {
  const packed = await runNpm(["pack", "--json", "--pack-destination", temporary], { cwd: packageDirectory });
  const packResult = JSON.parse(packed.stdout);
  const packedPaths = packResult[0].files.map((file) => file.path);
  const unexpectedBuiltInAdapters = packedPaths.filter((file) =>
    /^dist\/import-/.test(file) && !/^dist\/import-(?:codex|surfaceloom)\./.test(file));
  if (unexpectedBuiltInAdapters.length > 0) {
    throw new Error("Packed artifact contains an undeclared product adapter.");
  }
  if (packedPaths.some((file) => /(?:^|\/)(?:node_modules|\.env)(?:\/|$)/.test(file))) {
    throw new Error("Packed artifact contains a forbidden generated or environment path.");
  }
  if (!packedPaths.includes("dist/LICENSE")) throw new Error("Packed artifact is missing its MIT license.");
  const tarball = path.join(temporary, packResult[0].filename);
  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "@surfaceloom/agent-loop": `file:${tarball}` },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(consumer, "adapter.mjs"), runtimeSource(), "utf8");
  await writeFile(path.join(consumer, "adapter.ts"), typeSource(), "utf8");
  await writeFile(path.join(consumer, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true },
    include: ["adapter.ts"],
  }, null, 2)}\n`, "utf8");
  await runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });
  await run(process.execPath, ["adapter.mjs"], { cwd: consumer });
  const typescript = path.join(packageDirectory, "node_modules/typescript/bin/tsc");
  await run(process.execPath, [typescript, "-p", "tsconfig.json"], { cwd: consumer });
  const installedManifest = JSON.parse(await readFile(path.join(consumer, "node_modules/@surfaceloom/agent-loop/package.json"), "utf8"));
  if (installedManifest.exports?.["./adapter-sdk"] === undefined) throw new Error("Packed adapter SDK export is missing.");
  process.stdout.write("External adapter package contract passed.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function runNpm(arguments_, options) {
  const npmCli = process.env.npm_execpath;
  if (npmCli !== undefined && npmCli !== "") return run(process.execPath, [npmCli, ...arguments_], options);
  return run(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, options);
}

function runtimeSource() {
  return `import assert from "node:assert/strict";
import { importAgentLoop } from "@surfaceloom/agent-loop";
import { buildTrace } from "@surfaceloom/agent-loop/adapter-sdk";
const adapter = {
  id: "example/synthetic",
  detect: input => input === "synthetic" ? 100 : 0,
  import: (_input, options = {}) => buildTrace("example/synthetic", [{ id: "event-1", offsetMs: 0, lane: "agent", phase: "instant", name: "task.complete", status: "passed" }], [], options),
};
const trace = importAgentLoop("synthetic", { adapters: [adapter] });
assert.equal(trace.source, "example/synthetic");
assert.equal(trace.events[0]?.name, "task.complete");
`;
}

function typeSource() {
  return `import { importAgentLoop } from "@surfaceloom/agent-loop";
import { buildTrace, type TraceAdapter } from "@surfaceloom/agent-loop/adapter-sdk";
const adapter: TraceAdapter = {
  id: "example/synthetic",
  detect: input => input === "synthetic" ? 100 : 0,
  import: (_input, options = {}) => buildTrace("example/synthetic", [], [], options),
};
importAgentLoop("synthetic", { adapters: [adapter] });
`;
}
