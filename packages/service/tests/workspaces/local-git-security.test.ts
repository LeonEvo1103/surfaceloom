import assert from "node:assert/strict";
import { access, lstat, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  LocalGitWorkspaceProvider,
  runWorkspaceCommand,
  WorkspacePreparationError,
  type WorkspaceCommandInvocation,
} from "../../src/workspaces/index.js";
import { createGitFixture } from "./git-fixture.js";

test("prepares a detached immutable snapshot with resolved revision and metadata", async () => {
  const fixture = await createGitFixture();
  const commands: WorkspaceCommandInvocation[] = [];
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
      commandRunner: async (invocation) => {
        commands.push(invocation);
        return runWorkspaceCommand(invocation);
      },
    });
    const request = fixture.request("HEAD");
    const snapshot = await provider.prepare(request, new AbortController().signal);

    assert.equal(snapshot.resolvedRevision, fixture.revision);
    assert.notEqual(snapshot.rootPath, fixture.repository);
    const committed = await readFile(path.join(snapshot.rootPath, "committed.txt"), "utf8");
    assert.equal(committed.replaceAll("\r\n", "\n"), "committed\n");
    assert.deepEqual(snapshot.autMetadata, {
      sourceProvider: "local-git",
      sourceLocator: "fixture-repo",
    });
    assert.equal(snapshot.runtimeMetadata.isolation, "detached-readonly-copy");
    assert.equal(snapshot.runtimeMetadata.platform, process.platform);
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.runtimeMetadata));
    assert.ok(commands.length >= 6);
    assert.ok(commands.every((command) => command.shell === false));
    if (process.platform !== "win32") {
      assert.equal((await lstat(snapshot.rootPath)).mode & 0o777, 0o555);
    }
    assert.equal(provider.getOperation(request.operationId)?.status, "ready");
    assert.equal(provider.getOperation(request.operationId)?.snapshotId, snapshot.snapshotId);

    const receipt = await provider.release(snapshot, new AbortController().signal);
    assert.equal(receipt.status, "confirmed");
    await assert.rejects(access(snapshot.rootPath));
  } finally {
    await fixture.dispose();
  }
});

test("rejects traversal and symbolic-link source locators before Git execution", async () => {
  const fixture = await createGitFixture();
  let commandCount = 0;
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
      commandRunner: async (invocation) => {
        commandCount += 1;
        return runWorkspaceCommand(invocation);
      },
    });
    const traversal = {
      ...fixture.request(),
      source: { provider: "local-git", locator: "../fixture-repo" },
    };
    await assert.rejects(
      provider.prepare(traversal, new AbortController().signal),
      hasCode("path-unsafe"),
    );

    await symlink(
      fixture.repository,
      path.join(fixture.sourceRoot, "linked-repo"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const linked = {
      ...fixture.request(),
      source: { provider: "local-git", locator: "linked-repo" },
    };
    await assert.rejects(
      provider.prepare(linked, new AbortController().signal),
      hasCode("path-unsafe"),
    );
    assert.equal(commandCount, 0);
    assert.equal(provider.getOperation(traversal.operationId)?.status, "failed");
    assert.equal(provider.getOperation(linked.operationId)?.status, "failed");
  } finally {
    await fixture.dispose();
  }
});

test("dirty sources fail closed without returning or copying the current worktree", async () => {
  const fixture = await createGitFixture();
  try {
    await writeFile(path.join(fixture.repository, "untracked-secret.txt"), "not committed\n", "utf8");
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
    });
    const request = fixture.request();
    await assert.rejects(
      provider.prepare(request, new AbortController().signal),
      hasCode("dirty-worktree"),
    );
    const operation = provider.getOperation(request.operationId)!;
    assert.equal(operation.status, "failed");
    assert.equal(operation.snapshotId, undefined);
    assert.equal(operation.resolvedRevision, undefined);
    assert.deepEqual(await readdir(fixture.snapshotRoot), []);
  } finally {
    await fixture.dispose();
  }
});

test("revision resolution failure is tracked and never falls back to the source tree", async () => {
  const fixture = await createGitFixture();
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
    });
    const request = fixture.request("missing-revision");
    await assert.rejects(
      provider.prepare(request, new AbortController().signal),
      hasCode("revision-unresolved"),
    );
    const operation = provider.getOperation(request.operationId)!;
    assert.equal(operation.status, "failed");
    assert.equal(operation.snapshotId, undefined);
    assert.deepEqual(await readdir(fixture.snapshotRoot), []);
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
