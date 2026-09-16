#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const expectedLicense = "MIT";
const licenseText = await readFile(path.join(root, "LICENSE"), "utf8");

if (!licenseText.startsWith("MIT License\n\nCopyright (c) 2026 SurfaceLoom contributors\n")) {
  throw new Error("Root LICENSE is not the expected SurfaceLoom MIT license.");
}

const packagesRoot = path.join(root, "packages");
const entries = await readdir(packagesRoot, { withFileTypes: true });
const packageDirectories = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const directory of packageDirectories) {
  const packageRoot = path.join(packagesRoot, directory);
  const manifest = await readJson(path.join(packageRoot, "package.json"));
  if (manifest.license !== expectedLicense) {
    throw new Error(`${manifest.name ?? directory} package.json must declare ${expectedLicense}.`);
  }

  const lock = await readJson(path.join(packageRoot, "package-lock.json"));
  for (const [key, lockedPackage] of Object.entries(lock.packages ?? {})) {
    const isRoot = key === "";
    const isLocalSurfaceLoomPackage = key.startsWith("..")
      && typeof lockedPackage.name === "string"
      && lockedPackage.name.startsWith("@surfaceloom/");
    if ((isRoot || isLocalSurfaceLoomPackage) && lockedPackage.license !== expectedLicense) {
      throw new Error(`${directory}/package-lock.json entry ${key || "<root>"} must declare ${expectedLicense}.`);
    }
  }
}

process.stdout.write(`License contract passed: root and ${packageDirectories.length} packages use ${expectedLicense}\n`);

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
