import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const fixture = path.resolve("tests/fixtures/p3-090-public-consumer.type-fixture.ts");

test("built package root exposes the author facade and minimal Browser adapter SPI runtime", async () => {
  const publicApi = await import("@surfaceloom/test");
  assert.equal(typeof publicApi.bindAgentRun, "function");
  assert.equal(typeof publicApi.expectAgent, "function");
  assert.equal(typeof publicApi.defineCaseV3, "function");
  assert.equal(typeof publicApi.runCaseV3, "function");
  assert.equal(typeof publicApi.SurfaceProviderError, "function");
});

test("reference-shaped consumer typechecks through package roots without internal paths", async () => {
  const source = await readFile(fixture, "utf8");
  assert.doesNotMatch(source, /packages\/.+\/(?:src|dist)(?:\/|["'])/u);
  assert.doesNotMatch(source, /@surfaceloom\/test\//u);
  const typescript = path.resolve("node_modules/typescript/bin/tsc");
  await run(process.execPath, [typescript, "--noEmit", "--strict", "--skipLibCheck",
    "--exactOptionalPropertyTypes", "true", "--target", "ES2022", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", fixture], { cwd: process.cwd() });
});
