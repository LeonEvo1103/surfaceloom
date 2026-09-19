import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  acquireInteractiveSessionLease, InteractiveSessionLeaseError, releaseInteractiveSessionLease,
  type InteractiveSessionLease, type InteractiveSessionLeaseClaim,
} from "../src/interactive-session.js";
import { ResourceScope } from "../src/resources.js";
import { readLease } from "../src/interactive-session-storage.js";
import { attemptForeignRelease, LeaseChild } from "./interactive-session-support.js";

async function leaseDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "surfaceloom-interactive-session-"));
  const directory = path.join(root, "path with spaces");
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return directory;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof InteractiveSessionLeaseError
    && error.code === code);
}

async function metadata(lease: InteractiveSessionLease): Promise<Record<string, unknown>> {
  const value = await readLease(lease.path);
  assert.notEqual(value, null);
  return value as unknown as Record<string, unknown>;
}

async function writeLeaseDirectory(lockPath: string, value: Record<string, unknown> | string): Promise<void> {
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(path.join(lockPath, "owner.json"), typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
}

test("real processes contend without blocking the event loop and acquire after an ownership receipt", async (t) => {
  const directory = await leaseDirectory(t);
  const child = await LeaseChild.start(directory);
  t.after(async () => { await child.terminate(); });
  assert.equal((await child.next() as { type: string }).type, "acquired");
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 5);
  const pending = acquireInteractiveSessionLease({ directory, timeoutMs: 2_000, retryIntervalMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(ticks >= 3, "contention wait must yield rather than spin");
  child.send("release");
  assert.equal((await child.next() as { type: string }).type, "released");
  const lease = await pending;
  clearInterval(ticker);
  assert.equal((await lease.release()).status, "released");
});

test("timed-out child output waiter is removed and cannot consume a later frame", async (t) => {
  const directory = await leaseDirectory(t);
  const child = await LeaseChild.start(directory);
  t.after(async () => { await child.terminate(); });
  assert.equal((await child.next() as { type: string }).type, "acquired");
  await assert.rejects(child.next(5), /Timed out waiting for lease child output/u);
  child.send("release");
  assert.equal((await child.next() as { type: string }).type, "released");
});

test("AbortSignal and timeout stop only the waiter and preserve the current owner", async (t) => {
  const directory = await leaseDirectory(t);
  const owner = await acquireInteractiveSessionLease({ directory });
  const controller = new AbortController();
  const cancelled = acquireInteractiveSessionLease({ directory, timeoutMs: 2_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await expectCode(cancelled, "aborted");
  await expectCode(acquireInteractiveSessionLease({ directory, timeoutMs: 30, retryIntervalMs: 5 }), "timedOut");
  assert.deepEqual((await metadata(owner)).leaseToken, owner.leaseToken);
  await owner.release();
});

test("owner exit leaves no false receipt and a later process atomically recovers the stale lease", async (t) => {
  const directory = await leaseDirectory(t);
  const child = await LeaseChild.start(directory);
  const acquired = await child.next() as { claim: InteractiveSessionLeaseClaim };
  const lockPath = path.join(directory, "interactive-session.lease");
  child.send("exit");
  await child.waitForExit();
  await access(lockPath); // Process close is not a lease release receipt.
  const replacement = await acquireInteractiveSessionLease({ directory, timeoutMs: 2_000 });
  assert.notEqual(replacement.leaseToken, acquired.claim.leaseToken);
  await replacement.release();
});

test("dead PID and PID-reuse markers are reclaimable, while the new fencing token stays distinct", async (t) => {
  const directory = await leaseDirectory(t);
  const seed = await acquireInteractiveSessionLease({ directory });
  const stale = { ...await metadata(seed) };
  await seed.release();
  stale.pid = 2_147_483_647;
  stale.ownerNonce = randomUUID();
  stale.leaseToken = randomUUID();
  stale.acquiredAt = new Date().toISOString();
  await writeLeaseDirectory(seed.path, stale);
  const afterDeadPid = await acquireInteractiveSessionLease({ directory, timeoutMs: 2_000 });
  await afterDeadPid.release();

  const reused = { ...stale, pid: process.pid,
    processCreationMarker: `${seed.processCreationMarker}-different`,
    ownerNonce: randomUUID(), leaseToken: randomUUID(), acquiredAt: new Date().toISOString() };
  await writeLeaseDirectory(seed.path, reused);
  const afterReuse = await acquireInteractiveSessionLease({ directory, timeoutMs: 2_000 });
  assert.notEqual(afterReuse.leaseToken, reused.leaseToken);
  await afterReuse.release();
});

test("foreign, stale, and repeated release attempts cannot remove another lease", async (t) => {
  const directory = await leaseDirectory(t);
  const first = await acquireInteractiveSessionLease({ directory });
  assert.equal((await attemptForeignRelease(first) as { code: string }).code, "notOwner");
  assert.equal((await metadata(first)).leaseToken, first.leaseToken);
  const one = await first.release();
  const two = await first.release();
  assert.equal(one, two, "double release returns the original atomic receipt");

  const current = await acquireInteractiveSessionLease({ directory });
  await expectCode(releaseInteractiveSessionLease(first), "notOwner");
  assert.equal((await metadata(current)).leaseToken, current.leaseToken);
  await current.release();
});

test("atomic release is directly consumable as the kernel cleanup receipt", async (t) => {
  const directory = await leaseDirectory(t);
  const lease = await acquireInteractiveSessionLease({ directory });
  const scope = new ResourceScope();
  scope.register({ id: "interactive-session", ownership: "owned", cleanup: lease.release });
  const cleanup = await scope.close();
  assert.equal(cleanup.status, "passed");
  assert.equal(cleanup.outcomes[0]?.status, "released");
  const next = await acquireInteractiveSessionLease({ directory, timeoutMs: 100 });
  await next.release();
});

test("paths, names, options, and claims are strictly validated", async (t) => {
  const directory = await leaseDirectory(t);
  await expectCode(acquireInteractiveSessionLease({ directory: "relative" }), "invalidOptions");
  await expectCode(acquireInteractiveSessionLease({ directory, name: "../escape" }), "invalidOptions");
  await expectCode(acquireInteractiveSessionLease({ directory, timeoutMs: -1 }), "invalidOptions");
  await expectCode(acquireInteractiveSessionLease({ directory, retryIntervalMs: 0 }), "invalidOptions");
  const owner = await acquireInteractiveSessionLease({ directory });
  await expectCode(releaseInteractiveSessionLease({ ...owner, leaseToken: "not-a-token" }), "invalidOptions");
  assert.equal((await metadata(owner)).leaseToken, owner.leaseToken);
  await owner.release();
});

test("option and claim accessors or proxies are rejected without invoking user traps", async (t) => {
  const directory = await leaseDirectory(t);
  let getterReads = 0;
  const accessorOptions = Object.defineProperty({}, "directory", {
    enumerable: true, get: () => { getterReads += 1; return directory; },
  });
  await expectCode(acquireInteractiveSessionLease(accessorOptions as never), "invalidOptions");
  assert.equal(getterReads, 0);

  let proxyTraps = 0;
  const optionProxy = new Proxy({ directory }, {
    ownKeys: () => { proxyTraps += 1; return ["directory"]; },
    getPrototypeOf: () => { proxyTraps += 1; return Object.prototype; },
  });
  await expectCode(acquireInteractiveSessionLease(optionProxy), "invalidOptions");
  assert.equal(proxyTraps, 0);

  const owner = await acquireInteractiveSessionLease({ directory });
  const accessorClaim = { ...owner } as Record<string, unknown>;
  Object.defineProperty(accessorClaim, "directory", {
    enumerable: true, get: () => { getterReads += 1; return directory; },
  });
  await expectCode(releaseInteractiveSessionLease(accessorClaim as never), "invalidOptions");
  const claimProxy = new Proxy(owner, {
    ownKeys: () => { proxyTraps += 1; return []; },
    getPrototypeOf: () => { proxyTraps += 1; return Object.prototype; },
  });
  await expectCode(releaseInteractiveSessionLease(claimProxy), "invalidOptions");
  assert.equal(getterReads, 0);
  assert.equal(proxyTraps, 0);
  assert.equal((await metadata(owner)).leaseToken, owner.leaseToken);
  await owner.release();
});
