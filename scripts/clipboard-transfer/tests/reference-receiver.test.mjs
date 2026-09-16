import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { prepareTransfer } from "../lib/plan.mjs";
import { canonicalBase64, sha256, STATE_DIRECTORY } from "../lib/protocol.mjs";
import { ReferenceReceiver } from "../lib/reference-receiver.mjs";

const sessionId = "fedcba9876543210fedcba9876543210";

test("out-of-order chunks, duplicate replay, restart, and finalization succeed", async (context) => {
  const root = await temporaryRoot(context);
  const bytes = Buffer.from(Array.from({ length: 5_123 }, (_, index) => index % 251));
  const plan = prepareTransfer({ bytes, targetName: "result.bin", sessionId, chunkRawBytes: 700 });
  let receiver = new ReferenceReceiver(root);
  assert.equal(await receiver.init(plan.manifest), "created-or-present");
  assert.equal(await receiver.init(plan.manifest), "created-or-present");
  const reversed = [...plan.chunks].reverse();
  await receiver.add(plan.manifest, reversed[0]);
  assert.equal(await receiver.add(plan.manifest, reversed[0]), "already-present");
  assert.deepEqual((await receiver.status(plan.manifest)).missing, plan.chunks.slice(0, -1).map((chunk) => chunk.index));
  receiver = new ReferenceReceiver(root);
  for (const chunk of reversed.slice(1)) await receiver.add(plan.manifest, chunk);
  for (const chunk of plan.chunks) assert.equal(await receiver.add(plan.manifest, chunk), "already-present");
  assert.deepEqual(await receiver.status(plan.manifest), { received: plan.chunks.length, missing: [], missingRanges: "none" });
  assert.equal(await receiver.finalize(plan.manifest), "created");
  assert.deepEqual(await readFile(path.join(root, "result.bin")), bytes);
  assert.equal(await receiver.finalize(plan.manifest), "already-present");
  await assert.rejects(readFile(path.join(root, `.slm-clipboard-${sessionId}.partial`)), { code: "ENOENT" });
});

test("concurrent finalize calls serialize and converge on one exact target", async (context) => {
  const root = await temporaryRoot(context);
  const bytes = Buffer.alloc(4_097, 19);
  const plan = prepareTransfer({ bytes, targetName: "result.bin", sessionId, chunkRawBytes: 257 });
  const first = new ReferenceReceiver(root);
  const second = new ReferenceReceiver(root);
  await first.init(plan.manifest);
  for (const chunk of plan.chunks) await first.add(plan.manifest, chunk);
  const outcomes = await Promise.all([first.finalize(plan.manifest), second.finalize(plan.manifest)]);
  assert.deepEqual(outcomes.sort(), ["already-present", "created"]);
  assert.deepEqual(await readFile(path.join(root, "result.bin")), bytes);
});

test("status reports compact missing ranges and finalize rejects missing chunks", async (context) => {
  const root = await temporaryRoot(context);
  const plan = prepareTransfer({ bytes: Buffer.alloc(60, 4), targetName: "result.bin", sessionId, chunkRawBytes: 10 });
  const receiver = new ReferenceReceiver(root);
  await receiver.init(plan.manifest);
  await receiver.add(plan.manifest, plan.chunks[1]);
  await receiver.add(plan.manifest, plan.chunks[4]);
  assert.equal((await receiver.status(plan.manifest)).missingRanges, "0,2-3,5");
  await assert.rejects(receiver.finalize(plan.manifest), { code: "CHUNKS_MISSING" });
});

test("bad chunks and conflicting replay fail closed", async (context) => {
  const root = await temporaryRoot(context);
  const plan = prepareTransfer({ bytes: Buffer.alloc(32, 1), targetName: "result.bin", sessionId, chunkRawBytes: 16 });
  const receiver = new ReferenceReceiver(root);
  await receiver.init(plan.manifest);
  await assert.rejects(receiver.add(plan.manifest, { ...plan.chunks[0], base64: `${plan.chunks[0].base64.slice(0, -1)}A` }), { code: /BASE64|CHUNK/ });
  await receiver.add(plan.manifest, plan.chunks[0]);
  const alternate = Buffer.alloc(16, 2);
  await assert.rejects(receiver.add(plan.manifest, {
    index: 0,
    rawLength: alternate.length,
    sha256: sha256(alternate),
    base64: canonicalBase64(alternate),
  }), { code: "CHUNK_CONFLICT" });
  const chunkPath = path.join(root, STATE_DIRECTORY, sessionId, "chunks", "00000000.chunk.json");
  const frame = JSON.parse(await readFile(chunkPath, "utf8"));
  frame.p = frame.p.replace(/^./u, frame.p[0] === "A" ? "B" : "A");
  await writeFile(chunkPath, JSON.stringify(frame));
  await assert.rejects(receiver.status(plan.manifest), { code: /CHUNK|BASE64/ });
});

test("same session rejects a different manifest across receiver restarts", async (context) => {
  const root = await temporaryRoot(context);
  const original = prepareTransfer({ bytes: Buffer.from("one"), targetName: "one.bin", sessionId });
  const conflict = prepareTransfer({ bytes: Buffer.from("two"), targetName: "two.bin", sessionId });
  await new ReferenceReceiver(root).init(original.manifest);
  await assert.rejects(new ReferenceReceiver(root).init(conflict.manifest), { code: "SESSION_CONFLICT" });
});

test("whole-file hash is rechecked after every valid chunk", async (context) => {
  const root = await temporaryRoot(context);
  const plan = prepareTransfer({ bytes: Buffer.from("complete payload"), targetName: "result.bin", sessionId, chunkRawBytes: 4 });
  const forgedManifest = { ...plan.manifest, fileSha256: "0".repeat(64) };
  const receiver = new ReferenceReceiver(root);
  await receiver.init(forgedManifest);
  for (const chunk of plan.chunks) await receiver.add(forgedManifest, chunk);
  await assert.rejects(receiver.finalize(forgedManifest), { code: "FINAL_INTEGRITY_FAILED" });
  await assert.rejects(readFile(path.join(root, "result.bin")), { code: "ENOENT" });
});

test("existing target is idempotent only for exact length and hash", async (context) => {
  const root = await temporaryRoot(context);
  const bytes = Buffer.from("already there");
  const plan = prepareTransfer({ bytes, targetName: "result.bin", sessionId });
  await writeFile(path.join(root, "result.bin"), bytes);
  const receiver = new ReferenceReceiver(root);
  await receiver.init(plan.manifest);
  assert.equal(await receiver.finalize(plan.manifest), "already-present");
  await writeFile(path.join(root, "result.bin"), "different");
  await assert.rejects(receiver.finalize(plan.manifest), { code: "TARGET_CONFLICT" });
});

test("empty file finalizes without chunks", async (context) => {
  const root = await temporaryRoot(context);
  const plan = prepareTransfer({ bytes: Buffer.alloc(0), targetName: "empty.bin", sessionId });
  const receiver = new ReferenceReceiver(root);
  await receiver.init(plan.manifest);
  assert.equal(await receiver.finalize(plan.manifest), "created");
  assert.equal((await readFile(path.join(root, "empty.bin"))).length, 0);
});

test("unexpected chunk inventory blocks commit and cleanup", async (context) => {
  const root = await temporaryRoot(context);
  const plan = prepareTransfer({ bytes: Buffer.from("abc"), targetName: "result.bin", sessionId });
  const receiver = new ReferenceReceiver(root);
  await receiver.init(plan.manifest);
  await receiver.add(plan.manifest, plan.chunks[0]);
  await writeFile(path.join(root, STATE_DIRECTORY, sessionId, "chunks", "unexpected"), "x");
  await assert.rejects(receiver.finalize(plan.manifest), { code: "CHUNK_SET_CONFLICT" });
  await assert.rejects(receiver.cleanup(plan.manifest), { code: "CLEANUP_CONFLICT" });
});

test("symlink state and target are rejected without following them", async (context) => {
  const root = await temporaryRoot(context);
  const outside = await temporaryRoot(context);
  const plan = prepareTransfer({ bytes: Buffer.from("abc"), targetName: "result.bin", sessionId });
  await symlink(outside, path.join(root, STATE_DIRECTORY));
  await assert.rejects(new ReferenceReceiver(root).init(plan.manifest), { code: "REPARSE_REJECTED" });

  await rm(path.join(root, STATE_DIRECTORY));
  const receiver = new ReferenceReceiver(root);
  await receiver.init(plan.manifest);
  await symlink(path.join(outside, "outside.bin"), path.join(root, "result.bin"));
  await assert.rejects(receiver.finalize(plan.manifest), { code: "REPARSE_REJECTED" });
});

test("cleanup validates the manifest and removes only its exact session", async (context) => {
  const root = await temporaryRoot(context);
  const plan = prepareTransfer({ bytes: Buffer.from("abc"), targetName: "result.bin", sessionId });
  const receiver = new ReferenceReceiver(root);
  await receiver.init(plan.manifest);
  await receiver.add(plan.manifest, plan.chunks[0]);
  await mkdir(path.join(root, STATE_DIRECTORY, "other-session"));
  assert.equal(await receiver.cleanup(plan.manifest), "removed");
  assert.equal((await readFile(path.join(root, STATE_DIRECTORY, "other-session")).catch((error) => error.code)), "EISDIR");
});

async function temporaryRoot(context) {
  const root = await mkdtemp(path.join(process.cwd(), ".clipboard-transfer-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
