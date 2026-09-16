import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { discoverAgentLoopInputs } from "../src/index.js";

const run = promisify(execFile);

test("discovers trace-like files recursively without following symlinks or generated trees", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-discovery-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "nested"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "nested", "agent-session-trace.json"), "{}", "utf8");
  await writeFile(path.join(root, "nested", "rollout-1.jsonl"), "{}", "utf8");
  await writeFile(path.join(root, "nested", "settings.json"), "{}", "utf8");
  await writeFile(path.join(root, "node_modules", "hidden-trace.json"), "{}", "utf8");
  await symlink(path.join(root, "nested"), path.join(root, "linked"));

  const result = await discoverAgentLoopInputs([root]);
  assert.deepEqual(result.files.map((file) => path.basename(file)), ["agent-session-trace.json", "rollout-1.jsonl"]);
  assert.match(result.warnings[0] ?? "", /symbolic link/);
});

test("imports a directory of mixed recognized traces and reports rejected candidates", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-cli-batch-"));
  const output = path.join(root, "suite.html");
  context.after(async () => rm(root, { recursive: true, force: true }));
  const codex = { type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: {} };
  const native = { sequence: 1, timestamp: "2026-01-01T00:00:00Z", kind: "diagnostic", outcome: "passed" };
  await writeFile(path.join(root, "rollout-trace.jsonl"), JSON.stringify(codex), "utf8");
  await writeFile(path.join(root, "native-trace.jsonl"), JSON.stringify(native), "utf8");
  await writeFile(path.join(root, "unknown-trace.json"), "{}", "utf8");

  const result = await run(process.execPath, [
    path.resolve("dist/cli.js"), "--input-dir", root, "--output", output, "--title", "Mixed suite",
  ]);
  const html = await readFile(output, "utf8");
  assert.match(result.stderr, /Imported 2 trace files; skipped 1/);
  assert.match(html, /2 cases/);
  assert.match(html, /1 batch warning omitted/);
  assert.match(html, /Case 01 · surfaceloom/);
  assert.match(html, /Case 02 · codex/);
  assert.doesNotMatch(html, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("applies and sanitizes an explicit title in single-trace mode", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-cli-title-"));
  const input = path.join(root, "rollout.jsonl");
  const output = path.join(root, "trace.html");
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(input, JSON.stringify({ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: {} }), "utf8");

  await run(process.execPath, [
    path.resolve("dist/cli.js"), "--input", input, "--output", output, "--title", `Release sk-${"A".repeat(32)}`,
  ]);
  const html = await readFile(output, "utf8");
  assert.match(html, /Release \[REDACTED\]/);
  assert.doesNotMatch(html, /sk-A/);
});
