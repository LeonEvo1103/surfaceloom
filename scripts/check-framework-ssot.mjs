#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { validateFrameworkSsot } from "./lib/framework-ssot.mjs";

const ssot = new URL("../docs/FRAMEWORK_SSOT.md", import.meta.url);
const result = validateFrameworkSsot(await readFile(ssot, "utf8"));
process.stdout.write(
  `Framework SSOT passed: ${result.tasks.length} tasks, ${result.evidenceIds.length} acceptance records\n`,
);
