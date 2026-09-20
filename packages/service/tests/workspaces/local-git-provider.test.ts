import assert from "node:assert/strict";
import { access, chmod, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createRunId } from "../../src/ids.js";
import {
  LocalGitWorkspaceProvider,
  runWorkspaceCommand,
  WorkspacePreparationError,
} from "../../src/workspaces/index.js";
import { createGitFixture } from "./git-fixture.js";

test("concurrent prepares reserve operationId before performing I/O", async () => {
  const fixture = await createGitFixture();
  let unblock!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let first = true;
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
      commandRunner: async (invocation) => {
        if (first) {
          first = false;
          entered();
          await blocked;
        }
        return runWorkspaceCommand(invocation);
      },
    });
    const request = fixture.request();
    const preparing = provider.prepare(request, new AbortController().signal);
    await started;
    await assert.rejects(
      provider.prepare(request, new AbortController().signal),
      hasCode("operation-conflict"),
    );
    assert.equal(provider.getOperation(request.operationId)?.status, "preparing");
    unblock();
    const snapshot = await preparing;
    assert.equal(provider.getOperation(request.operationId)?.status, "ready");
    await provider.release(snapshot, new AbortController().signal);
  } finally {
    unblock?.();
    await fixture.dispose();
  }
});

test("separate concurrent operations get distinct snapshots", async () => {
  const fixture = await createGitFixture();
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
    });
    const [left, right] = await Promise.all([
      provider.prepare(fixture.request(), new AbortController().signal),
      provider.prepare(fixture.request(), new AbortController().signal),
    ]);
    assert.notEqual(left.snapshotId, right.snapshotId);
    assert.notEqual(left.rootPath, right.rootPath);
    await Promise.all([
      provider.release(left, new AbortController().signal),
      provider.release(right, new AbortController().signal),
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("active and cleanup-unconfirmed snapshots remain isolated and quarantined", async () => {
  const fixture = await createGitFixture();
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
    });
    const first = await provider.prepare(fixture.request(), new AbortController().signal);
    const runId = createRunId();
    const lease = provider.acquireLease(first, runId);
    const second = await provider.prepare(fixture.request(), new AbortController().signal);
    assert.notEqual(second.snapshotId, first.snapshotId);

    const activeRelease = await provider.release(first, new AbortController().signal);
    assert.equal(activeRelease.status, "unconfirmed");
    assert.equal(activeRelease.tainted, true);
    await access(first.rootPath);

    provider.completeLease(lease, {
      runId,
      snapshotId: first.snapshotId,
      status: "unconfirmed",
      tainted: true,
      attemptedAt: new Date().toISOString(),
      detail: "Owned process exit was not observed.",
    });
    const quarantinedRelease = await provider.release(first, new AbortController().signal);
    assert.equal(quarantinedRelease.status, "unconfirmed");
    assert.equal(quarantinedRelease.runId, runId);
    await access(first.rootPath);

    const third = await provider.prepare(fixture.request(), new AbortController().signal);
    assert.notEqual(third.snapshotId, first.snapshotId);
    assert.notEqual(third.snapshotId, second.snapshotId);
    await Promise.all([
      provider.release(second, new AbortController().signal),
      provider.release(third, new AbortController().signal),
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("cleanup identity mismatches fail closed and leave the lease active", async () => {
  const fixture = await createGitFixture();
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
    });
    const snapshot = await provider.prepare(fixture.request(), new AbortController().signal);
    const runId = createRunId();
    const lease = provider.acquireLease(snapshot, runId);
    assert.throws(() => provider.completeLease(lease, {
      runId: createRunId(),
      snapshotId: snapshot.snapshotId,
      status: "confirmed",
      tainted: false,
      attemptedAt: new Date().toISOString(),
    }), hasCode("snapshot-unsafe"));
    const receipt = await provider.release(snapshot, new AbortController().signal);
    assert.equal(receipt.status, "unconfirmed");
    assert.match(receipt.detail!, /active run lease/u);
  } finally {
    await fixture.dispose();
  }
});

test("post-prepare symlink replacement makes cleanup unconfirmed instead of following it", async () => {
  const fixture = await createGitFixture();
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
    });
    const snapshot = await provider.prepare(fixture.request(), new AbortController().signal);
    await chmod(snapshot.rootPath, 0o755);
    await symlink(fixture.repository, path.join(snapshot.rootPath, "escape"), "dir");
    const receipt = await provider.release(snapshot, new AbortController().signal);
    assert.equal(receipt.status, "unconfirmed");
    assert.equal(receipt.tainted, true);
    await access(fixture.repository);
    await access(snapshot.rootPath);
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
