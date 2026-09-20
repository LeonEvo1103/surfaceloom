import assert from "node:assert/strict";
import {
  access, chmod, lstat, mkdir, readFile, readdir, rename, symlink, writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  LocalGitWorkspaceProvider,
  runWorkspaceCommand,
  WorkspacePreparationError,
} from "../../src/workspaces/index.js";
import { createGitFixture } from "./git-fixture.js";

test("read-only conversion preserves executable bits and a clean Git status", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await createGitFixture();
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
    });
    const snapshot = await provider.prepare(fixture.request(), new AbortController().signal);
    assert.equal(
      (await lstat(path.join(snapshot.rootPath, "executable.sh"))).mode & 0o777,
      0o555,
    );
    assert.equal(
      (await lstat(path.join(snapshot.rootPath, "committed.txt"))).mode & 0o777,
      0o444,
    );
    const status = await runWorkspaceCommand({
      file: "git",
      args: ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd: snapshot.rootPath,
      signal: new AbortController().signal,
      shell: false,
    });
    assert.equal(status.exitCode, 0);
    assert.equal(status.stdout, "");
    await provider.release(snapshot, new AbortController().signal);
  } finally {
    await fixture.dispose();
  }
});

test("clone boundary rejects a repository replaced by an out-of-root symlink", async () => {
  const fixture = await createGitFixture();
  const movedRepository = path.join(fixture.root, "moved-repository");
  let attacked = false;
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
      commandRunner: async (invocation) => {
        if (!attacked && invocation.args[0] === "clone") {
          attacked = true;
          await rename(fixture.repository, movedRepository);
          await symlink(
            movedRepository,
            fixture.repository,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        return runWorkspaceCommand(invocation);
      },
    });
    const request = fixture.request();
    await assert.rejects(
      provider.prepare(request, new AbortController().signal),
      hasCode("path-unsafe"),
    );
    assert.equal(attacked, true);
    assert.equal(provider.getOperation(request.operationId)?.status, "failed");
    assert.deepEqual(await readdir(fixture.snapshotRoot), []);
  } finally {
    await fixture.dispose();
  }
});

test("clone boundary rejects replacement of the canonical snapshot root", async () => {
  const fixture = await createGitFixture();
  const movedSnapshotRoot = path.join(fixture.root, "moved-snapshots");
  let attacked = false;
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
      commandRunner: async (invocation) => {
        if (!attacked && invocation.args[0] === "clone") {
          attacked = true;
          await rename(fixture.snapshotRoot, movedSnapshotRoot);
          await mkdir(fixture.snapshotRoot);
        }
        return runWorkspaceCommand(invocation);
      },
    });
    const request = fixture.request();
    await assert.rejects(
      provider.prepare(request, new AbortController().signal),
      hasCode("path-unsafe"),
    );
    assert.equal(attacked, true);
    assert.equal(provider.getOperation(request.operationId)?.status, "failed");
    assert.equal((await readdir(fixture.snapshotRoot)).length, 1,
      "a replacement path without the reserved inode must not be removed");
  } finally {
    await fixture.dispose();
  }
});

for (const attackAfter of ["clone", "checkout"] as const) {
  test(`snapshot replacement after ${attackAfter} cannot redirect later writes into the source`, async () => {
    const fixture = await createGitFixture();
    const movedSnapshot = path.join(fixture.root, `moved-after-${attackAfter}`);
    let attacked = false;
    try {
      await writeFile(path.join(fixture.repository, "committed.txt"), "current source\n", "utf8");
      await fixture.git("add", "--", "committed.txt");
      await fixture.git("commit", "--quiet", "-m", "current source");
      const sourceHead = (await fixture.git("rev-parse", "HEAD")).trim();
      const provider = new LocalGitWorkspaceProvider({
        sourceRoot: fixture.sourceRoot,
        snapshotRoot: fixture.snapshotRoot,
        commandRunner: async (invocation) => {
          const result = await runWorkspaceCommand(invocation);
          if (!attacked && invocation.args[0] === attackAfter) {
            attacked = true;
            const destination = attackAfter === "clone"
              ? invocation.args.at(-1)!
              : invocation.cwd;
            await rename(destination, movedSnapshot);
            await symlink(
              fixture.repository,
              destination,
              process.platform === "win32" ? "junction" : "dir",
            );
          }
          return result;
        },
      });

      await assert.rejects(
        provider.prepare(fixture.request(fixture.revision), new AbortController().signal),
        hasCode("snapshot-unsafe"),
      );
      assert.equal(attacked, true);
      assert.equal((await fixture.git("rev-parse", "HEAD")).trim(), sourceHead);
      assert.equal(await readFile(path.join(fixture.repository, "committed.txt"), "utf8"),
        "current source\n");
      assert.equal(await fixture.git("status", "--porcelain=v1", "--untracked-files=all"), "");
    } finally {
      await fixture.dispose();
    }
  });
}

test("release quarantines a replaced snapshot root without chmod or removal through its symlink", async () => {
  const fixture = await createGitFixture();
  const movedSnapshot = path.join(fixture.root, "moved-before-release");
  try {
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: fixture.snapshotRoot,
    });
    const snapshot = await provider.prepare(fixture.request(), new AbortController().signal);
    const sourceHead = (await fixture.git("rev-parse", "HEAD")).trim();
    const sourceMode = (await lstat(fixture.repository)).mode & 0o777;
    const fileMode = (await lstat(path.join(fixture.repository, "committed.txt"))).mode & 0o777;
    await chmod(snapshot.rootPath, 0o755);
    await rename(snapshot.rootPath, movedSnapshot);
    await symlink(
      fixture.repository,
      snapshot.rootPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const receipt = await provider.release(snapshot, new AbortController().signal);

    assert.equal(receipt.status, "unconfirmed");
    assert.equal(receipt.tainted, true);
    assert.equal((await fixture.git("rev-parse", "HEAD")).trim(), sourceHead);
    assert.equal(await readFile(path.join(fixture.repository, "committed.txt"), "utf8"), "committed\n");
    assert.equal(await fixture.git("status", "--porcelain=v1", "--untracked-files=all"), "");
    assert.equal((await lstat(fixture.repository)).mode & 0o777, sourceMode);
    assert.equal((await lstat(path.join(fixture.repository, "committed.txt"))).mode & 0o777, fileMode);
    assert.equal((await lstat(snapshot.rootPath)).isSymbolicLink(), true);
    await access(movedSnapshot);
  } finally {
    await fixture.dispose();
  }
});

test("canonical roots cannot overlap through a symlinked parent", async () => {
  const fixture = await createGitFixture();
  const alias = path.join(fixture.root, "source-alias");
  try {
    await symlink(
      fixture.sourceRoot,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const provider = new LocalGitWorkspaceProvider({
      sourceRoot: fixture.sourceRoot,
      snapshotRoot: path.join(alias, "embedded-snapshots"),
    });
    await assert.rejects(
      provider.prepare(fixture.request(), new AbortController().signal),
      hasCode("path-unsafe"),
    );
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
