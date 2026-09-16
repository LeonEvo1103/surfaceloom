import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PlaywrightBrowserBackend, type BrowserSession } from "../src/index.js";
import { fakePlaywright } from "./fakes.js";

test("captured artifacts land on disk as owner-only files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "desktop-browser-perm-"));
  try {
    const session = await launch();
    const screenshotPath = path.join(directory, "page.png");
    const tracePath = path.join(directory, "trace.zip");

    const screenshot = await session.screenshot(screenshotPath);
    await session.startTrace();
    const trace = await session.stopTrace(tracePath);
    await session.close();

    // The capture really produced files, so the mode assertions below observe bytes
    // on disk rather than a fake that only recorded a path.
    assert.equal((await stat(screenshot.sourcePath)).isFile(), true);
    assert.equal((await stat(trace.sourcePath)).isFile(), true);
    assert.equal(screenshot.sensitive, true);
    assert.equal(trace.sensitive, true);
    if (process.platform === "win32") return;
    assert.equal((await stat(screenshotPath)).mode & 0o777, 0o600);
    assert.equal((await stat(tracePath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an already permissive output directory does not loosen artifact files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "desktop-browser-perm-"));
  try {
    // The 0o700 mode on mkdir only applies when mkdir creates the directory, so a
    // pre-existing world-readable directory is the case where the directory can
    // never be the confinement barrier.
    const directory = path.join(root, "shared");
    await mkdir(directory, { recursive: true });
    if (process.platform !== "win32") await chmod(directory, 0o755);

    const session = await launch();
    const screenshotPath = path.join(directory, "page.png");
    const screenshot = await session.screenshot(screenshotPath);
    await session.close();

    assert.equal((await stat(screenshot.sourcePath)).isFile(), true);
    if (process.platform === "win32") return;
    assert.equal((await stat(directory)).mode & 0o777, 0o755);
    assert.equal((await stat(screenshotPath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function launch(): Promise<BrowserSession> {
  return new PlaywrightBrowserBackend(async () => fakePlaywright()).launch();
}
