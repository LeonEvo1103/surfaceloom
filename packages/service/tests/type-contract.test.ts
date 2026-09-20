import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("published declarations enforce run lifecycle and outcome unions", () => {
  const result = spawnSync(process.execPath, [
    path.resolve("node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--strict",
    "--exactOptionalPropertyTypes",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--target", "ES2022",
    "--skipLibCheck",
    "tests/type-fixtures/run-result-contract.ts",
  ], { cwd: process.cwd(), encoding: "utf8" });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
