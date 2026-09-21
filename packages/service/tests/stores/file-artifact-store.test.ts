import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRunId, FileArtifactStore, StoreConflictError, StoreCorruptionError,
} from "../../src/index.js";

test("artifact bytes survive restart and are verified by digest", async (t) => {
  const root = await temporary(t);
  const runId = createRunId();
  const source = Buffer.from("bounded evidence", "utf8");
  const store = await FileArtifactStore.open(root);
  const artifact = await store.put({ runId, name: "report.json",
    mediaType: "application/json", data: source });
  source.fill(0);

  const reopened = await FileArtifactStore.open(root);
  const stored = await reopened.get(artifact.artifactId);
  assert.equal(Buffer.from(stored!.data).toString("utf8"), "bounded evidence");
  assert.deepEqual(await reopened.list(runId), [artifact]);
  assert.deepEqual(await reopened.put({ runId, name: "report.json",
    mediaType: "application/json", data: Buffer.from("bounded evidence") }), artifact);
});

test("artifact byte budget fails before writing", async (t) => {
  const store = await FileArtifactStore.open(await temporary(t), { maxArtifactBytes: 3 });
  await assert.rejects(store.put({ runId: createRunId(), name: "large.log",
    mediaType: "text/plain", data: Buffer.from("four") }), StoreConflictError);
});

test("concurrent identical puts publish complete bytes before either call returns", async (t) => {
  const store = await FileArtifactStore.open(await temporary(t));
  const request = { runId: createRunId(), name: "large.bin",
    mediaType: "application/octet-stream", data: Buffer.alloc(32 * 1024 * 1024, 0x5a) };
  const artifacts = await Promise.all([0, 1].map(async () => {
    const artifact = await store.put(request);
    const stored = await store.get(artifact.artifactId);
    assert.equal(stored?.data.byteLength, request.data.byteLength);
    assert.equal(stored?.data[stored.data.byteLength - 1], 0x5a);
    return artifact;
  }));
  assert.deepEqual(artifacts[0], artifacts[1]);
});

test("manifest lookup rejects swapped identity and put repairs the requested artifact", async (t) => {
  const root = await temporary(t);
  const store = await FileArtifactStore.open(root);
  const runId = createRunId();
  const leftRequest = { runId, name: "left.txt", mediaType: "text/plain",
    data: Buffer.from("left") };
  const left = await store.put(leftRequest);
  const right = await store.put({ runId, name: "right.txt", mediaType: "text/plain",
    data: Buffer.from("right") });
  await writeFile(manifestPath(root, left.artifactId), `${JSON.stringify(right)}\n`, "utf8");

  await assert.rejects(store.get(left.artifactId), StoreCorruptionError);
  assert.deepEqual(await store.put(leftRequest), left);
  assert.equal(Buffer.from((await store.get(left.artifactId))!.data).toString(), "left");
});

function manifestPath(root: string, artifactId: string): string {
  const digest = createHash("sha256").update(artifactId).digest("hex");
  return path.join(root, "manifests", `${digest}.json`);
}

async function temporary(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-artifact-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
