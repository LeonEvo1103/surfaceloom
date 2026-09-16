#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { prepareTransfer } from "./lib/plan.mjs";

let options;
let stagingDirectory;

try {
  options = parseArguments(process.argv.slice(2));
  const input = await readFile(options.input).catch(() => { throw safeError("INPUT_READ_FAILED"); });
  const plan = prepareTransfer({
    bytes: input,
    targetName: options.targetName,
    sessionId: options.sessionId,
    chunkRawBytes: options.chunkRawBytes,
    maxCommandChars: options.maxCommandChars,
  });
  const outputDirectory = path.resolve(options.outputDirectory);
  const parent = path.dirname(outputDirectory);
  await assertPlainDirectory(parent);
  if (await exists(outputDirectory)) throw safeError("OUTBOX_EXISTS");
  stagingDirectory = path.join(parent, `.${path.basename(outputDirectory)}.tmp-${randomUUID()}`);
  await mkdir(path.join(stagingDirectory, "commands", "init"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(stagingDirectory, "commands", "chunks"), { mode: 0o700 });

  const initFiles = [];
  for (const [index, command] of plan.initCommands.entries()) {
    const relative = `commands/init/${String(index).padStart(3, "0")}.ps1.txt`;
    await writeFrame(stagingDirectory, relative, command);
    initFiles.push({ commandFile: relative, expectedMarker: expectedInitMarker(command) });
  }
  const chunkFiles = [];
  for (const chunk of plan.chunks) {
    const relative = `commands/chunks/${String(chunk.index).padStart(8, "0")}.frame.txt`;
    await writeFrame(stagingDirectory, relative, chunk.frame);
    chunkFiles.push({ index: chunk.index, rawLength: chunk.rawLength, sha256: chunk.sha256, frameFile: relative, expectedMarker: `CT_CHUNK_OK SESSION=${plan.manifest.sessionId} INDEX=${chunk.index}` });
  }
  const controls = {};
  for (const name of ["receiveLoop", "status", "finalize", "cleanup", "abortInit"]) {
    const relative = `commands/${name}.ps1.txt`;
    await writeFrame(stagingDirectory, relative, plan[name]);
    controls[name] = relative;
  }
  const loopControls = {};
  for (const name of ["loopStatus", "loopFinalize", "loopQuit", "loopCleanup"]) {
    const relative = `commands/${name}.frame.txt`;
    await writeFrame(stagingDirectory, relative, plan[name]);
    loopControls[name] = relative;
  }
  const summary = {
    protocol: plan.manifest.protocol,
    sessionId: plan.manifest.sessionId,
    targetName: plan.manifest.targetName,
    totalLength: plan.manifest.totalLength,
    fileSha256: plan.manifest.fileSha256,
    chunkRawBytes: plan.manifest.chunkRawBytes,
    chunkCount: plan.manifest.chunkCount,
    manifestSha256: plan.manifestHash,
    receiverSha256: plan.receiver.engineHash,
    maxCommandChars: plan.maxCommandChars,
    longestCommandChars: plan.longestCommandChars,
    initCommands: initFiles,
    initCommandFiles: initFiles.map((entry) => entry.commandFile),
    chunks: chunkFiles,
    ...controls,
    ...loopControls,
  };
  await writeFile(path.join(stagingDirectory, "plan.json"), `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await writeFile(path.join(stagingDirectory, "READY"), "slm-clipboard-v1\n", { encoding: "ascii", mode: 0o600, flag: "wx" });
  await rename(stagingDirectory, outputDirectory).catch(() => { throw safeError("OUTBOX_PUBLISH_FAILED"); });
  stagingDirectory = undefined;
  process.stdout.write(`CT_PREPARE_OK SESSION=${plan.manifest.sessionId} CHUNKS=${plan.manifest.chunkCount} MAX_COMMAND_CHARS=${plan.longestCommandChars} OUTBOX=${path.basename(outputDirectory)}\n`);
} catch (error) {
  if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
  process.stderr.write(`CT_PREPARE_ERROR ${isSafeCode(error?.code) ? error.code : "INTERNAL_ERROR"}\n`);
  process.exitCode = 1;
}

async function writeFrame(root, relative, command) {
  await writeFile(path.join(root, relative), command, { encoding: "ascii", mode: 0o600, flag: "wx" });
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw safeError("INVALID_ARGUMENTS");
    if (values.has(key)) throw safeError("INVALID_ARGUMENTS");
    values.set(key, value);
  }
  for (const required of ["--input", "--target-name", "--output-dir"]) {
    if (!values.has(required)) throw safeError("INVALID_ARGUMENTS");
  }
  for (const key of values.keys()) {
    if (!["--input", "--target-name", "--output-dir", "--session-id", "--chunk-bytes", "--max-command-chars"].includes(key)) {
      throw safeError("INVALID_ARGUMENTS");
    }
  }
  return {
    input: values.get("--input"),
    targetName: values.get("--target-name"),
    outputDirectory: values.get("--output-dir"),
    sessionId: values.get("--session-id"),
    chunkRawBytes: parseOptionalInteger(values.get("--chunk-bytes")),
    maxCommandChars: parseOptionalInteger(values.get("--max-command-chars")),
  };
}

function parseOptionalInteger(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw safeError("INVALID_ARGUMENTS");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw safeError("INVALID_ARGUMENTS");
  return parsed;
}

async function assertPlainDirectory(directory) {
  const stat = await lstat(directory).catch(() => { throw safeError("OUTPUT_PARENT_INVALID"); });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw safeError("OUTPUT_PARENT_INVALID");
}

async function exists(candidate) {
  try { await lstat(candidate); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw safeError("OUTPUT_CHECK_FAILED"); }
}

function safeError(code) { const error = new Error(code); error.code = code; return error; }
function isSafeCode(code) { return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code); }
function expectedInitMarker(command) {
  const matches = command.match(/CT_INIT_[A-Z_]+(?: SESSION=[a-f0-9]{32})?(?: INDEX=\d+)?/gu);
  return matches?.at(-1) ?? "CT_INIT_OK";
}
