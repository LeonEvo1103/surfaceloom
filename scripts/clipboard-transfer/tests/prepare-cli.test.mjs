import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const scriptsRoot = path.resolve("scripts/clipboard-transfer");

test("prepare CLI publishes a ready outbox without payload in logs or metadata", async (context) => {
  const root = await mkdtemp(path.join(process.cwd(), ".clipboard-outbox-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "private-input.bin");
  const output = path.join(root, "outbox");
  const payload = Buffer.from("unique-payload-that-must-not-appear-in-logs");
  await writeFile(input, payload);
  const result = await runNode([
    path.join(scriptsRoot, "prepare.mjs"),
    "--input", input,
    "--target-name", "artifact.bin",
    "--output-dir", output,
    "--session-id", "00112233445566778899aabbccddeeff",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^CT_PREPARE_OK /u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(escapePattern(input), "u"));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(payload.toString("base64"), "u"));
  assert.equal(await readFile(path.join(output, "READY"), "ascii"), "slm-clipboard-v1\n");
  const summaryText = await readFile(path.join(output, "plan.json"), "utf8");
  assert.doesNotMatch(summaryText, new RegExp(payload.toString("base64"), "u"));
  const summary = JSON.parse(summaryText);
  assert.ok(summary.longestCommandChars <= summary.maxCommandChars);
  const commandFiles = await collectFiles(path.join(output, "commands"));
  assert.equal(commandFiles.length, summary.initCommandFiles.length + summary.chunkCount + 9);
  for (const file of commandFiles) {
    const frame = await readFile(file, "ascii");
    assert.match(frame, /^[\x20-\x7e]+$/u);
    assert.doesNotMatch(frame, /[\r\n\0]/u);
    assert.ok(frame.length <= summary.maxCommandChars);
  }

  const replay = await runNode([
    path.join(scriptsRoot, "prepare.mjs"),
    "--input", input,
    "--target-name", "artifact.bin",
    "--output-dir", output,
  ]);
  assert.equal(replay.code, 1);
  assert.equal(replay.stderr, "CT_PREPARE_ERROR OUTBOX_EXISTS\n");
});

test("prepare CLI reports invalid input without a stack or path echo", async () => {
  const result = await runNode([path.join(scriptsRoot, "prepare.mjs"), "--input"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "CT_PREPARE_ERROR INVALID_ARGUMENTS\n");
});

async function runNode(argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argumentsList, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(signal));
      else resolve({ code, stdout, stderr });
    });
  });
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(candidate));
    else files.push(candidate);
  }
  return files;
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
