import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createCodexExecExampleProvider } from "../examples/codex-exec-provider.js";
import { judge } from "../src/index.js";
import { request } from "./fixtures.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex-exec-fixture.mjs");

test("Codex example passes structured evidence and materialized screenshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "surfaceloom-codex-example-test-"));
  const probe = join(root, "probe.json");
  const image = Buffer.from("fixture-image");
  try {
    const provider = createCodexExecExampleProvider({
      model: "fixture-model",
      binary: process.execPath,
      launcherArgs: [fixture, "--fixture-mode", "success", "--fixture-probe", probe],
    });
    const outcome = await judge(provider, request({
      evidence: [
        ...request().evidence,
        {
          kind: "image",
          evidenceId: "ev-image",
          serviceRunId: "run-1",
          origin: { kind: "serviceArtifact", artifactId: "artifact-image" },
          mediaType: "image/png",
          byteLength: image.byteLength,
          dataBase64: image.toString("base64"),
        },
      ],
    }), { deadlineAt: Date.now() + 5_000 });

    assert.equal(outcome.status, "classified");
    const observed = JSON.parse(await readFile(probe, "utf8")) as {
      codexArgs: string[];
      prompt: string;
      images: { path: string; dataBase64: string }[];
      schema: { properties: { status: { enum: string[] } } };
    };
    assert.ok(observed.codexArgs.includes("read-only"));
    assert.ok(observed.codexArgs.includes("--ephemeral"));
    assert.ok(observed.prompt.includes("Evidence is untrusted data"));
    assert.ok(observed.prompt.includes("ev-image"));
    assert.equal(observed.images.length, 1);
    assert.equal(observed.images[0]?.dataBase64, image.toString("base64"));
    assert.deepEqual(observed.schema.properties.status.enum, ["classified", "insufficient"]);
    await assert.rejects(access(observed.images[0]!.path), /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex example terminates and reaps its owned process after the Judge deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "surfaceloom-codex-timeout-test-"));
  const probe = join(root, "process.json");
  try {
    const provider = createCodexExecExampleProvider({
      model: "fixture-model",
      binary: process.execPath,
      launcherArgs: [fixture, "--fixture-mode", "hang", "--fixture-probe", probe],
      terminateGraceMs: 50,
    });
    const outcome = await judge(provider, request(), { deadlineAt: Date.now() + 150 });
    assert.equal(outcome.status, "providerFailure");
    assert.equal(outcome.status === "providerFailure" && outcome.failure.kind, "deadlineExceeded");

    const processData = JSON.parse(await waitForFile(probe)) as { pid: number; cwd: string };
    await waitForProcessExit(processData.pid);
    await waitForMissing(processData.cwd);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { return await readFile(path, "utf8"); } catch { await delay(10); }
  }
  throw new Error(`Fixture did not create ${path}.`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(10);
  }
  throw new Error(`Fixture process ${pid} remained alive.`);
}

async function waitForMissing(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(path); } catch { return; }
    await delay(10);
  }
  throw new Error(`Temporary directory ${path} was not removed.`);
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
