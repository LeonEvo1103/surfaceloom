#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

async function testFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await testFiles(candidate));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(candidate);
  }
  return files;
}

const files = await testFiles("tests");
if (files.length === 0) throw new Error("No TypeScript contract tests were discovered.");

const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
// These contracts include real subprocesses and short deadline/cancellation
// windows. Parallel test files contend for small hosted runners and can expire
// before reaching the behavior under test. Keep every assertion, but serialize
// files in CI; local runs retain Node's default concurrency.
const scheduling = process.env.CI === "true" ? ["--test-concurrency=1"] : [];
const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [tsxCli, "--test", ...scheduling, ...files], {
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal !== null) reject(new Error(`TypeScript tests stopped by ${signal}.`));
    else resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
