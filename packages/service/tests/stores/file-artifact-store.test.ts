import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRunId, FileArtifactStore, StoreConflictError } from "../../src/index.js";

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

async function temporary(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-artifact-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
