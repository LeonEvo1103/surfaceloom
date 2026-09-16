#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverRepositoryContractTests } from "./lib/repository-contract-discovery.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const discovered = await discoverRepositoryContractTests(repositoryRoot);

const exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--test", ...discovered], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal !== null) reject(new Error(`Repository contracts stopped by ${signal}.`));
    else resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
