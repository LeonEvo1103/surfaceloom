import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRunId, FileRunStore, parseTestId, StoreConflictError,
} from "../../src/index.js";

test("requestId reservation survives restart and retries reuse the original run", async (t) => {
  const root = await temporary(t);
  const runId = createRunId();
  const input = reservation(runId, "request-one");
  const first = await FileRunStore.open(root);
  const created = await first.reserve(input);
  assert.equal(created.created, true);
  await first.close();

  const reopened = await FileRunStore.open(root);
  const retried = await reopened.reserve({ ...input, proposedRunId: createRunId() });
  assert.equal(retried.created, false);
  assert.equal(retried.record.runId, runId);
  assert.equal((await reopened.get(runId))?.status, "queued");

  await assert.rejects(reopened.reserve({ ...input, fingerprint: "b".repeat(64) }),
    StoreConflictError);
});

test("restart turns every non-terminal run into interrupted and tainted", async (t) => {
  const root = await temporary(t);
  const runId = createRunId();
  const store = await FileRunStore.open(root);
  await store.reserve(reservation(runId, "request-recovery"));
  await store.markRunning(runId, "2026-09-21T00:00:01.000Z");
  await store.close();

  const reopened = await FileRunStore.open(root);
  const recovered = await reopened.recoverInterrupted("2026-09-21T00:00:02.000Z");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, "interrupted");
  assert.equal(recovered[0]?.tainted, true);
  assert.equal(recovered[0]?.cleanup?.status, "unconfirmed");
  assert.match(recovered[0]?.cleanup?.detail ?? "", /quarantined/u);
  assert.equal((await reopened.recoverInterrupted("2026-09-21T00:00:03.000Z")).length, 0);
});

test("run store serializes concurrent artifact updates without losing either record", async (t) => {
  const store = await FileRunStore.open(await temporary(t));
  const runId = createRunId();
  await store.reserve(reservation(runId, "request-artifacts"));
  await Promise.all(["one", "two"].map((name) => store.attachArtifact(runId, {
    artifactId: `artifact:${name}`, runId, name: `${name}.txt`, mediaType: "text/plain",
    sizeBytes: 3, sha256: name === "one" ? "1".repeat(64) : "2".repeat(64),
  }, "2026-09-21T00:00:01.000Z")));
  assert.deepEqual((await store.get(runId))?.artifacts.map(item => item.name).sort(),
    ["one.txt", "two.txt"]);
});

function reservation(runId: ReturnType<typeof createRunId>, requestId: string) {
  return { requestId, fingerprint: "a".repeat(64), proposedRunId: runId,
    snapshot: { snapshotId: "snapshot-fixture", resolvedRevision: "abc123" },
    testId: parseTestId("service-test:reference/smoke"),
    parameters: { locale: "zh-CN" }, createdAt: "2026-09-21T00:00:00.000Z" } as const;
}

async function temporary(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-run-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
