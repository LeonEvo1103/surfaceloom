#!/usr/bin/env node

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const packageRoot = process.cwd();
const repositoryRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.resolve(packageRoot, "dist");
if (path.dirname(outputDirectory) !== packageRoot || path.basename(outputDirectory) !== "dist") {
  throw new Error("Refusing to write outside the current package dist directory.");
}
await mkdir(outputDirectory, { recursive: true });
await copyFile(path.join(repositoryRoot, "LICENSE"), path.join(outputDirectory, "LICENSE"));
