#!/usr/bin/env node

import { rm } from "node:fs/promises";
import path from "node:path";

const packageRoot = process.cwd();
const target = path.resolve(packageRoot, "dist");
if (path.basename(target) !== "dist" || path.dirname(target) !== packageRoot) {
  throw new Error("Refusing to clean a path outside the current package.");
}
await rm(target, { recursive: true, force: true });
