import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { prepareTransfer } from "../lib/plan.mjs";
import { buildChunkCommand } from "../lib/powershell.mjs";

const scriptsRoot = path.resolve("scripts/clipboard-transfer");

test("generated PowerShell is product-neutral and has the required safety gates", async () => {
  const receiver = await readFile(path.join(scriptsRoot, "powershell", "receiver.ps1"), "utf8");
  const generator = await readFile(path.join(scriptsRoot, "lib", "powershell.mjs"), "utf8");
  const windowsE2e = await readFile(path.join(scriptsRoot, "test-windows-e2e.ps1"), "utf8");
  for (const required of [
    "ReparsePoint",
    "Get-ExpectedChunkLength",
    "Convert-CanonicalBase64",
    "Get-Sha256 $partial",
    "[IO.File]::Move($partial, $Context.Target)",
    "Enter-SessionLock",
    "CT_SESSION_CONFLICT",
    "CT_TARGET_CONFLICT",
    "return ,$bytes",
    "return ,$missing",
    "Read-Host",
    "Invoke-DataFrame",
    "CT_PATH_TOO_LONG",
    "$maxWorkingRootChars = 120",
    "$maxFullPathChars = 240",
  ]) assert.ok(receiver.includes(required), required);
  assert.doesNotMatch(receiver, /Invoke-Expression|Write-Output\s+\$Payload/iu);
  assert.doesNotMatch(receiver, /\?\?|\?\.|ForEach-Object\s+-Parallel|ConvertFrom-Json\s+-AsHashtable/iu);
  assert.match(windowsE2e, /powershell|scriptblock|CT_WINDOWS_E2E_OK/iu);

  const plan = prepareTransfer({
    bytes: Buffer.from("payload"),
    targetName: "semi;colon.bin",
    sessionId: "00112233445566778899aabbccddeeff",
  });
  assert.match(generator, /`& \$b -Action '\$\{action\}'/u);
  assert.doesNotMatch(generator, /`&\$b -Action/u);
  const invocationCommands = [
    buildChunkCommand(plan.manifest, plan.manifestHash, plan.chunks[0]),
    plan.receiveLoop,
    plan.status,
    plan.finalize,
    plan.cleanup,
  ];
  for (const command of invocationCommands) {
    assert.match(command, /;& \$b -Action/u, "Windows PowerShell 5.1 requires whitespace after the call operator");
    assert.doesNotMatch(command, /;&\$b -Action/u);
  }
  for (const command of [...plan.initCommands, plan.abortInit, plan.receiveLoop, plan.status, plan.finalize, plan.cleanup]) {
    assert.ok(command.startsWith("&{"), "frame must use a local PowerShell scope");
    assert.ok(command.length <= 1_800);
    assert.doesNotMatch(command, /Invoke-Expression/u);
    assert.doesNotMatch(command, /::new\(,/u, "unary comma is not legal in a method argument list");
  }
  for (const frame of [...plan.chunks.map((chunk) => chunk.frame), plan.loopStatus, plan.loopFinalize, plan.loopQuit, plan.loopCleanup]) {
    assert.match(frame, /^SLMCT1\|/u);
    assert.ok(frame.length <= 1_800);
    assert.doesNotMatch(frame, /[\r\n\0]/u);
  }
  assert.match(plan.initCommands[0], /ProviderPath\.Length-gt120/u);
  assert.match(plan.initCommands[0], /ProviderPath\.Length\+1\+14\)-gt240/u);
  assert.match(plan.initCommands[0], /CT_PATH_TOO_LONG/u);
  assert.match(receiver, /\$Root\.Length \+ 1 \+ \$manifest\.targetName\.Length\) -gt \$maxFullPathChars/u);
  const inventoryFrame = plan.initCommands.find((command) => command.includes("CT_INIT_INVENTORY_OK"));
  assert.ok(inventoryFrame, "inventory frame must exist");
  assert.ok(inventoryFrame.includes("CT_INIT_INV_FRAME_INVALID"));
  const inventory = decodeCompressedCommand(inventoryFrame);
  for (const code of [
    "CT_INIT_INV_MANIFEST_HASH",
    "CT_INIT_INV_ENUM",
    "CT_INIT_INV_PART_COUNT",
    "CT_INIT_INV_ITEM",
  ]) assert.ok(inventory.includes(code), code);
  assert.match(inventory, /Where-Object \{\$_\.Name-match/u);
  assert.match(inventory, /\.Count-ne\d+\)/u);
  assert.doesNotMatch(inventory, /\$n\.n|ConvertFrom-Json/u);
  assert.doesNotMatch(inventory, /CT_INIT_CONFLICT/u);
  const abortSource = decodeCompressedCommand(plan.abortInit);
  assert.match(abortSource, /if\(Test-Path -LiteralPath \$p\).*Get-FileHash -LiteralPath \$p/su);
  assert.match(abortSource, /if\(Test-Path -LiteralPath \$p\)\{Remove-Item -LiteralPath \$p -Force\}/u);
  assert.doesNotMatch(abortSource, /CT_INIT_ABORT_NOT_APPLICABLE/u);
});

test("cleanup accepts replay-safe engine work files and rejects broader bootstrap inventory", async () => {
  const receiver = await readFile(path.join(scriptsRoot, "powershell", "receiver.ps1"), "utf8");
  const cleanupStart = receiver.indexOf('$bootstrap = [IO.Path]::Combine($session, "bootstrap")');
  const cleanupEnd = receiver.indexOf('Remove-Item -LiteralPath ([IO.Path]::Combine($session, "manifest.json"))', cleanupStart);
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart, "cleanup bootstrap block must exist");
  const cleanup = receiver.slice(cleanupStart, cleanupEnd);
  const patternMatch = cleanup.match(/\$item\.Name -cnotmatch '([^']+)'/u);
  assert.ok(patternMatch, "cleanup must enforce a case-sensitive exact bootstrap filename pattern");
  const allowedName = new RegExp(patternMatch[1], "u");
  const plan = prepareTransfer({
    bytes: Buffer.from("payload"),
    targetName: "artifact.bin",
    sessionId: "00112233445566778899aabbccddeeff",
  });
  const engineWorkPattern = /engine\\\.\(\?:gz\(\?:\\\.work\)\?\|raw\\\.work\)/u;
  const inventory = decodeCompressedCommand(plan.initCommands.find((command) => command.includes("CT_INIT_INVENTORY_OK")));
  const abort = decodeCompressedCommand(plan.abortInit);

  for (const name of [
    "engine-manifest.json",
    "engine.gz",
    "engine.gz.work",
    "engine.raw.work",
    "0000.part",
    ".tmp-0123456789abcdef0123456789abcdef",
  ]) assert.match(name, allowedName, name);
  for (const name of [
    "engine.raw",
    "engine.raw.work.extra",
    "ENGINE.RAW.WORK",
    "unexpected.item",
    ".tmp-0123456789abcdef0123456789abcdeg",
  ]) assert.doesNotMatch(name, allowedName, name);

  assert.match(cleanup, engineWorkPattern, "cleanup schema must include the exact engine work states");
  assert.match(inventory, engineWorkPattern, "init inventory must use the same engine work states");
  assert.match(abort, engineWorkPattern, "abort inventory must use the same engine work states");

  assert.match(
    cleanup,
    /\$item\.PSIsContainer -or \(\$item\.Attributes -band \[IO\.FileAttributes\]::ReparsePoint\) -ne 0 -or \$item\.Name -cnotmatch/u,
    "type and reparse checks must run in addition to the exact filename whitelist",
  );
});

test("every generated outbox PowerShell frame has a zero-error AST", async (context) => {
  const root = await mkdtemp(path.join(process.cwd(), ".clipboard-ast-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input.bin");
  const output = path.join(root, "outbox");
  await writeFile(input, Buffer.alloc(129_256, 0xa5));
  const prepare = await runNode([
    path.join(scriptsRoot, "prepare.mjs"),
    "--input", input,
    "--target-name", "payload.zip",
    "--output-dir", output,
    "--session-id", "0123456789abcdef0123456789abcdef",
  ]);
  assert.equal(prepare.code, 0, prepare.stderr);

  const executable = process.env.SURFACELOOM_POWERSHELL_EXE || (process.platform === "win32" ? "powershell.exe" : "pwsh");
  let parsed;
  try {
    parsed = await runProcess(executable, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File", path.join(scriptsRoot, "test-outbox-powershell-syntax.ps1"),
      "-Outbox", output,
      "-IncludeSources",
    ]);
  } catch (error) {
    if (error?.code === "ENOENT" && process.platform !== "win32" && !process.env.SURFACELOOM_POWERSHELL_EXE) {
      context.skip("pwsh is unavailable; the Windows CI job runs this gate with Windows PowerShell 5.1");
      return;
    }
    throw error;
  }
  assert.equal(parsed.code, 0, `${parsed.stdout}${parsed.stderr}`);
  assert.match(parsed.stdout, /^CT_AST_OK OUTBOX_FILES=\d+ SOURCE_FILES=2\s*$/u);
  assert.doesNotMatch(`${parsed.stdout}${parsed.stderr}`, /CT_AST_ERROR/u);
});

async function runNode(argumentsList) {
  return runProcess(process.execPath, argumentsList);
}

async function runProcess(executable, argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argumentsList, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(signal)) : resolve({ code, stdout, stderr }));
  });
}

function decodeCompressedCommand(command) {
  const encoded = command.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/u)?.[1];
  assert.ok(encoded, "compressed command must contain one Base64 payload");
  return gunzipSync(Buffer.from(encoded, "base64")).toString("utf8");
}
