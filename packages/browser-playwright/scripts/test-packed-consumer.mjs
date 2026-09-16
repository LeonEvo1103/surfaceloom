import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoot = fileURLToPath(new URL("./", import.meta.url));
const temporary = mkdtempSync(path.join(os.tmpdir(), "surfaceloom-browser-consumer-"));
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run through npm run test:packed so the current npm CLI is available.");
const npm = (args, cwd) => execFileSync(process.execPath, [npmCli, ...args], {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
try {
  const [archive] = JSON.parse(npm(["pack", "--json", "--pack-destination", temporary], root));
  assert.equal(archive.name, "@surfaceloom/browser-playwright");
  assert(archive.files.some(({ path }) => path === "dist/LICENSE"));
  assert(!archive.files.some(({ path }) => /^(src|tests|node_modules|\.cache)\//u.test(path)));
  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
    path.join(temporary, archive.filename)], temporary);
  const manifest = JSON.parse(readFileSync(
    path.join(temporary, "node_modules/@surfaceloom/browser-playwright/package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.exports), ["."]);
  assert(!Object.values(manifest.dependencies ?? {}).some((value) => value.startsWith("file:")));
  for (const fixture of ["packed-consumer.mjs", "packed-consumer.mts"]) {
    copyFileSync(path.join(fixtureRoot, fixture), path.join(temporary, fixture));
  }
  execFileSync(process.execPath, [
    path.join(root, "node_modules/typescript/bin/tsc"),
    "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", "--target", "ES2022", "packed-consumer.mts",
  ], { cwd: temporary, stdio: "inherit" });
  execFileSync(process.execPath, ["packed-consumer.mjs"], {
    cwd: temporary, stdio: "inherit",
  });
  console.log("Packed browser public exports, types, lifecycle and artifacts passed.");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
