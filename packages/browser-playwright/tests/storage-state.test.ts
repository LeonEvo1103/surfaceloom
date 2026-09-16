import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BrowserAutomationError,
  defineDomLocator,
  PlaywrightBrowserBackend,
} from "../src/index.js";
import type {
  PlaywrightBrowserLike,
  PlaywrightContextLike,
  PlaywrightPageLike,
  PlaywrightTracingLike,
} from "../src/playwright-shapes.js";
import { PlaywrightBrowserSession } from "../src/session.js";
import { FakeBrowserType, FakePage, fakePlaywright } from "./fakes.js";

import { storageStateSession } from "./storage-state-fakes.js";

test("exports storage state as a sensitive reusable-login artifact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-browser-state-"));
  try {
    const { session, context } = storageStateSession();
    const statePath = path.join(directory, "login.json");

    const artifact = await session.saveStorageState(statePath);

    // No destination reaches Playwright: its writer truncates before it writes,
    // so this package must take the returned state and land it itself. Without an
    // opt-in the payload also carries no indexedDB key, keeping the export
    // byte-identical to the pre-flag behaviour.
    assert.deepEqual(context.storageStateCalls, [{}]);
    assert.deepEqual(Object.keys(context.storageStateCalls[0] ?? {}), []);
    // The double never writes a file, so a reachable, matching payload here can
    // only come from this package's own writer.
    const written = await readFile(statePath, "utf8");
    assert.deepEqual(JSON.parse(written), context.storageStateResult);
    assert.equal(written, JSON.stringify(context.storageStateResult, undefined, 2));
    await assert.rejects(access(`${statePath}.partial`), /ENOENT/);
    if (process.platform !== "win32") {
      assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      {
        kind: artifact.kind,
        contentType: artifact.contentType,
        sensitive: artifact.sensitive,
        sourcePath: artifact.sourcePath,
      },
      {
        kind: "storageState",
        contentType: "application/json",
        sensitive: true,
        sourcePath: statePath,
      },
    );
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshing an existing storage state file replaces it in place", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-browser-refresh-"));
  try {
    const { session, context } = storageStateSession();
    const statePath = path.join(directory, "login.json");

    await session.saveStorageState(statePath);
    // Re-logging in to refresh an existing state file is the documented main
    // use case, so the destination itself must never be opened exclusively.
    context.storageStateResult = { cookies: [{ name: "sid", value: "refreshed" }], origins: [] };
    await session.saveStorageState(statePath);

    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), context.storageStateResult);
    await assert.rejects(access(`${statePath}.partial`), /ENOENT/);
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to overwrite a partial export another writer owns", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-browser-partial-"));
  try {
    const { session, context } = storageStateSession();
    const statePath = path.join(directory, "login.json");
    await writeFile(`${statePath}.partial`, "other-writer", "utf8");

    await assert.rejects(
      session.saveStorageState(statePath),
      (error: unknown) =>
        error instanceof BrowserAutomationError
        && error.code === "artifactState"
        && !error.message.includes(statePath),
    );

    // The residue belongs to whoever is mid-write; clearing it here would erase
    // a concurrent export, and the destination must stay untouched.
    assert.equal(await readFile(`${statePath}.partial`, "utf8"), "other-writer");
    await assert.rejects(access(statePath), /ENOENT/);
    assert.deepEqual(context.storageStateCalls, [{}]);
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("clears its own partial file when the export cannot be published", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-browser-cleanup-"));
  try {
    const { session } = storageStateSession();
    const statePath = path.join(directory, "login.json");
    // A directory at the destination makes the rename fail after the partial is
    // already staged, which is the only window that can leave debris behind.
    await mkdir(statePath);

    await assert.rejects(
      session.saveStorageState(statePath),
      (error: unknown) =>
        error instanceof BrowserAutomationError
        && error.code === "operationFailed"
        && !error.message.includes(statePath),
    );

    await assert.rejects(access(`${statePath}.partial`), /ENOENT/);
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("includes IndexedDB in the storage state export only on explicit opt-in", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-browser-idb-"));
  try {
    const { session, context } = storageStateSession();
    const enabledPath = path.join(directory, "with-idb.json");
    const disabledPath = path.join(directory, "without-idb.json");

    await session.saveStorageState(enabledPath, { indexedDB: true });
    await session.saveStorageState(disabledPath, { indexedDB: false });

    assert.deepEqual(context.storageStateCalls, [
      { indexedDB: true },
      // An explicit false is equivalent to not asking: the key is dropped rather
      // than forwarded, so "not opted in" has exactly one wire shape.
      {},
    ]);
    assert.deepEqual(Object.keys(context.storageStateCalls[1] ?? {}), []);
    await session.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects storage state exports on relative paths, failures, and closed sessions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-browser-state-"));
  try {
    const active = storageStateSession();
    const statePath = path.join(directory, "session.json");

    await assert.rejects(
      active.session.saveStorageState("relative-state.json"),
      (error: unknown) =>
        error instanceof BrowserAutomationError && error.code === "invalidArgument",
    );
    assert.deepEqual(active.context.storageStateCalls, []);

    active.context.storageStateFailure = new Error(`cookie=secret written to ${statePath}`);
    await assert.rejects(
      active.session.saveStorageState(statePath),
      (error: unknown) =>
        error instanceof BrowserAutomationError &&
        error.code === "operationFailed" &&
        !error.message.includes(statePath) &&
        !error.message.includes("secret"),
    );
    await active.session.close();

    const closed = storageStateSession();
    await closed.session.close();
    await assert.rejects(
      closed.session.saveStorageState(statePath),
      (error: unknown) =>
        error instanceof BrowserAutomationError && error.code === "sessionClosed",
    );
    assert.deepEqual(closed.context.storageStateCalls, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
