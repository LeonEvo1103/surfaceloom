import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

import { createRunId } from "../../src/ids.js";
import {
  LocalGitWorkspaceProvider,
  runWorkspaceCommand,
  WorkspacePreparationError,
} from "../../src/workspaces/index.js";
import { createGitFixture } from "./git-fixture.js";

test("release excludes a lease acquired later in the same tick", async () => {
  const fixture = await createGitFixture();
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
    });
    const snapshot = await provider.prepare(fixture.request(), new AbortController().signal);

    const releasing = provider.release(snapshot, new AbortController().signal);
    assert.throws(
      () => provider.acquireLease(snapshot, createRunId()),
      hasCode("snapshot-unsafe"),
    );
    const receipt = await releasing;
    assert.equal(receipt.status, "confirmed");
    await assert.rejects(access(snapshot.rootPath));
  } finally {
    await fixture.dispose();
  }
});

test("lease generation prevents stale same-run same-time ABA completion", async () => {
  const fixture = await createGitFixture();
  const fixedTime = new Date("2026-09-21T00:00:00.000Z");
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
      now: () => fixedTime,
    });
    const snapshot = await provider.prepare(fixture.request(), new AbortController().signal);
    const runId = createRunId();
    const first = provider.acquireLease(snapshot, runId);
    const confirmed = {
      runId,
      snapshotId: snapshot.snapshotId,
      status: "confirmed" as const,
      tainted: false,
      attemptedAt: fixedTime.toISOString(),
    };
    provider.completeLease(first, confirmed);

    const second = provider.acquireLease(snapshot, runId);
    assert.equal(first.acquiredAt, second.acquiredAt);
    assert.notEqual(first.generation, second.generation);
    assert.throws(
      () => provider.completeLease(first, confirmed),
      hasCode("snapshot-unsafe"),
    );
    const whileActive = await provider.release(snapshot, new AbortController().signal);
    assert.equal(whileActive.status, "unconfirmed");
    await access(snapshot.rootPath);

    provider.completeLease(second, confirmed);
    const released = await provider.release(snapshot, new AbortController().signal);
    assert.equal(released.status, "confirmed");
  } finally {
    await fixture.dispose();
  }
});

test("a repeated snapshot UUID cannot delete an active snapshot owned by another operation", async () => {
  const fixture = await createGitFixture();
  const fixedUuid = "11111111-1111-4111-8111-111111111111";
  let commandCount = 0;
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
      createUuid: () => fixedUuid,
      commandRunner: async (invocation) => {
        commandCount += 1;
        return runWorkspaceCommand(invocation);
      },
    });
    const first = await provider.prepare(fixture.request(), new AbortController().signal);
    const runId = createRunId();
    const lease = provider.acquireLease(first, runId);
    const countBeforeCollision = commandCount;

    await assert.rejects(
      provider.prepare(fixture.request(), new AbortController().signal),
      hasCode("snapshot-unsafe"),
    );
    assert.equal(commandCount, countBeforeCollision);
    await access(first.rootPath);

    provider.completeLease(lease, {
      runId,
      snapshotId: first.snapshotId,
      status: "confirmed",
      tainted: false,
      attemptedAt: new Date().toISOString(),
    });
    const released = await provider.release(first, new AbortController().signal);
    assert.equal(released.status, "confirmed");
  } finally {
    await fixture.dispose();
  }
});

test("concurrent prepares with one UUID grant physical ownership to only one operation", async () => {
  const fixture = await createGitFixture();
  const fixedUuid = "22222222-2222-4222-8222-222222222222";
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
      createUuid: () => fixedUuid,
    });
    const results = await Promise.allSettled([
      provider.prepare(fixture.request(), new AbortController().signal),
      provider.prepare(fixture.request(), new AbortController().signal),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.status === "rejected");
    assert.ok(rejected[0].reason instanceof WorkspacePreparationError);
    assert.equal(rejected[0].reason.code, "snapshot-unsafe");
    assert.ok(fulfilled[0]?.status === "fulfilled");
    await access(fulfilled[0].value.rootPath);
    const receipt = await provider.release(fulfilled[0].value, new AbortController().signal);
    assert.equal(receipt.status, "confirmed");
  } finally {
    await fixture.dispose();
  }
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof WorkspacePreparationError);
    assert.equal(error.code, code);
    return true;
  };
}
