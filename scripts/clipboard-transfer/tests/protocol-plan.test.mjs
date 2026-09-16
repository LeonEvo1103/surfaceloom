import assert from "node:assert/strict";
import test from "node:test";

import { prepareTransfer } from "../lib/plan.mjs";
import {
  buildManifest,
  canonicalBase64,
  decodeCanonicalBase64,
  expectedChunkLength,
  formatRanges,
  MAX_CHUNKS,
  validateTargetName,
} from "../lib/protocol.mjs";

const sessionId = "0123456789abcdef0123456789abcdef";

test("boundary sizes produce exact chunks and bounded one-line ASCII commands", () => {
  for (const length of [0, 1, 1_535, 1_536, 1_537, 4_609]) {
    const bytes = Buffer.alloc(length);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
    const plan = prepareTransfer({ bytes, targetName: "传输 包.zip", sessionId });
    assert.equal(plan.manifest.totalLength, length);
    assert.equal(plan.chunks.length, length === 0 ? 0 : Math.ceil(length / plan.manifest.chunkRawBytes));
    for (const command of allCommands(plan)) {
      assert.ok(command.length <= plan.maxCommandChars, `${command.length} exceeds ${plan.maxCommandChars}`);
      assert.match(command, /^[\x20-\x7e]+$/u);
      assert.doesNotMatch(command, /[\r\n\0]/u);
    }
    for (const chunk of plan.chunks) {
      assert.equal(chunk.rawLength, expectedChunkLength(plan.manifest, chunk.index));
      assert.equal(decodeCanonicalBase64(chunk.base64).length, chunk.rawLength);
      assert.ok(chunk.base64.length <= 2_048);
    }
  }
});

test("all byte values round-trip through canonical Base64", () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const encoded = canonicalBase64(bytes);
  assert.deepEqual(decodeCanonicalBase64(encoded), bytes);
  for (const invalid of ["A", "AAA", "AAAA\n", "AAAA ", "AAAA=", "====", "_AAA"]) {
    assert.throws(() => decodeCanonicalBase64(invalid), { code: "NON_CANONICAL_BASE64" });
  }
});

test("target leaf validation rejects traversal, ADS, device, and injection names", () => {
  for (const accepted of ["artifact.zip", "构建 包.zip", "semi;colon.bin", "bracket[1].dat"]) {
    assert.equal(validateTargetName(accepted), accepted);
  }
  for (const rejected of [
    "", ".", "..", "../x", "a/b", "a\\b", "C:\\x", "\\\\server\\share",
    "x:stream", "x*", "x?", "x.", "x ", "CON", "nul.txt", "COM1.bin", "LPT9",
    "COM¹", "com².txt", "LPT³", "CONIN$", "CONOUT$.txt", "CLOCK$", ".slm-clipboard-transfer", `.slm-clipboard-${sessionId}.partial`,
    "quote\".zip", "line\nfeed.zip", "e\u0301.zip",
  ]) {
    assert.throws(() => validateTargetName(rejected), { code: "INVALID_TARGET_NAME" }, rejected);
  }
});

test("command limit is a hard gate and never silently exceeded", () => {
  const bytes = Buffer.alloc(20_000, 7);
  const plan = prepareTransfer({ bytes, targetName: "a.bin", sessionId, chunkRawBytes: 8_000 });
  assert.ok(plan.manifest.chunkRawBytes < 8_000);
  assert.ok(plan.longestCommandChars <= 1_800);
  assert.throws(
    () => prepareTransfer({ bytes, targetName: "a.bin", sessionId, maxCommandChars: 1_024 }),
    { code: "COMMAND_LIMIT_TOO_SMALL" },
  );
});

test("verified 129256-byte payload stays below 1800 chars without frame explosion", () => {
  const plan = prepareTransfer({ bytes: Buffer.alloc(129_256, 3), targetName: "payload.zip", sessionId });
  assert.equal(plan.manifest.chunkRawBytes, 1_200);
  assert.equal(plan.chunks.length, 108);
  assert.ok(plan.initCommands.length < 60);
  assert.ok(plan.longestCommandChars <= 1_800);
  assert.ok(plan.chunks.every((chunk) => chunk.frame.length <= 1_800));
});

test("manifest bounds and missing ranges are deterministic", () => {
  assert.equal(formatRanges([]), "none");
  assert.equal(formatRanges([9, 1, 2, 3, 7, 9, 11, 10]), "1-3,7,9-11");
  assert.throws(
    () => buildManifest({ sessionId, targetName: "a", bytes: Buffer.alloc(MAX_CHUNKS + 1), chunkRawBytes: 1 }),
    { code: "TOO_MANY_CHUNKS" },
  );
});

function allCommands(plan) {
  return [
    ...plan.initCommands,
    plan.abortInit,
    ...plan.chunks.map((chunk) => chunk.frame),
    plan.receiveLoop,
    plan.status,
    plan.finalize,
    plan.cleanup,
    plan.loopStatus,
    plan.loopFinalize,
    plan.loopQuit,
    plan.loopCleanup,
  ];
}
