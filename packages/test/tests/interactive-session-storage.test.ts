import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  acquireInteractiveSessionLease, InteractiveSessionLeaseError,
  type InteractiveSessionLease,
} from "../src/interactive-session.js";
import type { InteractiveSessionLeaseMetadata } from "../src/interactive-session-contracts.js";
import { observeLinuxProcessIdentity } from "../src/interactive-session-process.js";
import { moveLeaseToProof, publishLease, readLease } from "../src/interactive-session-storage.js";

async function leaseDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-interactive-storage-"));
  const directory = path.join(root, "path with spaces");
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return directory;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof InteractiveSessionLeaseError
    && error.code === code);
}

async function metadata(lease: InteractiveSessionLease): Promise<InteractiveSessionLeaseMetadata> {
  const value = await readLease(lease.path);
  assert.notEqual(value, null);
  return value!;
}

async function writeLease(lockPath: string, source: string): Promise<void> {
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(path.join(lockPath, "owner.json"), source);
}

test("Linux missing process stat is absent but unreadable boot identity remains conservative", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  let reads = 0;
  const absent = await observeLinuxProcessIdentity(999_999, { readFile: async () => {
    reads += 1;
    throw missing;
  } });
  assert.deepEqual(absent, { status: "absent" });
  assert.equal(reads, 1, "boot identity must not be read after the process stat is absent");

  const fields = ["S", ...Array.from({ length: 18 }, () => "0"), "12345"];
  const unknown = await observeLinuxProcessIdentity(42, { readFile: async (candidate) => {
    if (candidate.endsWith("/stat")) return `42 (fixture) ${fields.join(" ")}\n`;
    throw missing;
  } });
  assert.deepEqual(unknown, { status: "unknown" }, "boot_id failure must not declare a live PID absent");
});

test("malformed, noncanonical, and symlink metadata fail closed without deleting the path", async (t) => {
  for (const source of ["not json\n", '{"schema":"x","schema":"y"}\n']) {
    const directory = await leaseDirectory(t);
    await mkdir(directory, { recursive: true });
    const lockPath = path.join(directory, "interactive-session.lease");
    await writeLease(lockPath, source);
    await expectCode(acquireInteractiveSessionLease({ directory, timeoutMs: 20 }), "corruptLease");
    assert.equal(await readFile(path.join(lockPath, "owner.json"), "utf8"), source);
  }
  const directory = await leaseDirectory(t);
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, "target.json");
  await writeFile(target, "{}\n");
  const lockPath = path.join(directory, "interactive-session.lease");
  await mkdir(lockPath);
  await symlink(target, path.join(lockPath, "owner.json"));
  await expectCode(acquireInteractiveSessionLease({ directory, timeoutMs: 20 }), "corruptLease");
  await expectCode(readLease(lockPath, { useNoFollow: false }), "corruptLease");

  const missingDirectory = await leaseDirectory(t);
  await mkdir(missingDirectory, { recursive: true });
  const missingOwner = path.join(missingDirectory, "interactive-session.lease");
  await mkdir(missingOwner);
  await expectCode(readLease(missingOwner, { useNoFollow: false }), "corruptLease");
});

test("Windows no-follow fallback detects a deterministic lstat-to-open replacement race", async (t) => {
  const directory = await leaseDirectory(t);
  const lease = await acquireInteractiveSessionLease({ directory });
  const ownerPath = path.join(lease.path, "owner.json");
  const source = await readFile(ownerPath, "utf8");
  const target = path.join(directory, "replacement.json");
  await writeFile(target, source);
  await expectCode(readLease(lease.path, { useNoFollow: false, afterInitialStat: async () => {
    await unlink(ownerPath);
    await symlink(target, ownerPath);
  } }), "corruptLease");
});

test("legal generation rename and republish returns retry across both metadata windows", async (t) => {
  for (const seam of ["afterDirectoryStat", "afterInitialStat"] as const) {
    const directory = await leaseDirectory(t);
    const old = await acquireInteractiveSessionLease({ directory });
    let current!: InteractiveSessionLease;
    const replaceGeneration = async (): Promise<void> => {
      await old.release();
      current = await acquireInteractiveSessionLease({ directory });
    };
    const runtime = seam === "afterDirectoryStat"
      ? { useNoFollow: false, afterDirectoryStat: replaceGeneration }
      : { useNoFollow: false, afterInitialStat: replaceGeneration };
    assert.equal(await readLease(old.path, runtime), null,
      `${seam} replacement must be retried rather than reported as corrupt`);
    assert.equal((await readLease(current.path))?.leaseToken, current.leaseToken);
    await expectCode(acquireInteractiveSessionLease({ directory, timeoutMs: 20, retryIntervalMs: 5 }), "timedOut");
    await current.release();
  }
});

test("successful directory publication has no fallible cleanup after ownership changes", async (t) => {
  const directory = await leaseDirectory(t);
  const seed = await acquireInteractiveSessionLease({ directory });
  const base = await metadata(seed);
  await seed.release();
  const candidate = { ...base, ownerNonce: randomUUID(), leaseToken: randomUUID(),
    acquiredAt: new Date().toISOString() } as InteractiveSessionLeaseMetadata;
  const cleanupError = Object.assign(new Error("injected pending cleanup failure"), { code: "EACCES" });
  let cleanupCalls = 0;
  const result = await publishLease(seed.path, candidate, {
    cleanupTemporary: async () => { cleanupCalls += 1; throw cleanupError; },
    renameDirectory: rename,
  });
  assert.equal(result.status, "acquired");
  assert.equal(cleanupCalls, 0);
  assert.deepEqual(await readLease(seed.path), candidate);

  const occupied = { ...candidate, ownerNonce: randomUUID(), leaseToken: randomUUID(),
    acquiredAt: new Date().toISOString() } as InteractiveSessionLeaseMetadata;
  await assert.rejects(publishLease(seed.path, occupied, {
    cleanupTemporary: async () => { cleanupCalls += 1; throw cleanupError; },
    renameDirectory: rename,
  }), (error: unknown) => error === cleanupError);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(await readLease(seed.path), candidate);
});

test("occupied rename errno is stable after the competing owner immediately releases", async (t) => {
  const directory = await leaseDirectory(t);
  for (const code of ["ENOTEMPTY", "EEXIST"]) {
    const competitor = await acquireInteractiveSessionLease({ directory });
    const base = await metadata(competitor);
    const candidate = { ...base, ownerNonce: randomUUID(), leaseToken: randomUUID(),
      acquiredAt: new Date().toISOString() } as InteractiveSessionLeaseMetadata;
    const occupied = Object.assign(new Error("destination was occupied"), { code });
    const result = await publishLease(competitor.path, candidate, {
      cleanupTemporary: async (temporary) => { await rm(temporary, { recursive: true, force: true }); },
      renameDirectory: async () => {
        await competitor.release();
        throw occupied;
      },
    });
    assert.equal(result.status, "occupied");
    assert.equal(await readLease(competitor.path), null,
      "classification must not depend on destination still existing after rename fails");
    assert.equal((await publishLease(competitor.path, candidate)).status, "acquired");
    assert.equal(await moveLeaseToProof(competitor.path, candidate, "released"), true);
  }

  const seed = await acquireInteractiveSessionLease({ directory });
  const candidate = { ...await metadata(seed), ownerNonce: randomUUID(), leaseToken: randomUUID(),
    acquiredAt: new Date().toISOString() } as InteractiveSessionLeaseMetadata;
  await seed.release();
  for (const code of ["EIO", "EPERM", "EACCES"]) {
    const unknown = Object.assign(new Error("injected filesystem failure"), { code });
    await assert.rejects(publishLease(seed.path, candidate, {
      cleanupTemporary: async (temporary) => { await rm(temporary, { recursive: true, force: true }); },
      renameDirectory: async () => { throw unknown; },
    }), (error: unknown) => error === unknown);
  }
  assert.equal(await readLease(seed.path), null);
});

test("retired-token fencing prevents a delayed stale recoverer from renaming a new owner", async (t) => {
  const directory = await leaseDirectory(t);
  const old = await acquireInteractiveSessionLease({ directory });
  const oldMetadata = await metadata(old);
  let resume!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const delayed = moveLeaseToProof(old.path, oldMetadata, "released", { beforeRename: async () => {
    entered();
    await paused;
  } });
  await ready;
  assert.equal(await moveLeaseToProof(old.path, oldMetadata, "stale"), true);
  const current = await acquireInteractiveSessionLease({ directory });
  resume();
  assert.equal(await delayed, false);
  assert.equal((await readLease(current.path))?.leaseToken, current.leaseToken);
  await current.release();
});
