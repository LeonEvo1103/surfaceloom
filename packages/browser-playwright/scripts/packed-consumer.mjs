import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  PlaywrightBrowserBackend, defineDomLocator, BrowserAutomationError,
} from "@surfaceloom/browser-playwright";

const listeners = new Map();
let disposed = false;
let closed = 0;
const page = {
  on: (event, listener) => listeners.set(event, listener),
  off: (event) => listeners.delete(event),
  getByTestId: () => ({
    first() { return this; },
    waitFor: async () => {},
    count: async () => 1,
    elementHandle: async () => ({
      isVisible: async () => true,
      isEnabled: async () => false,
      dispose: async () => { disposed = true; },
    }),
  }),
};
const context = {
  newPage: async () => page,
  storageState: async (options) => {
    assert.deepEqual(options, { indexedDB: true });
    return { cookies: [], origins: [] };
  },
  close: async () => { closed += 1; },
};
const browser = { newContext: async () => context, close: async () => { closed += 1; } };
const engine = { launch: async () => browser };
const backend = new PlaywrightBrowserBackend(async () => ({
  chromium: engine, firefox: engine, webkit: engine,
}));
const session = await backend.launch();
const observations = session.observe({ limit: 1 });
listeners.get("console")({ type: () => "log", text: () => "first" });
listeners.get("console")({ type: () => "log", text: () => "second" });
const batch = observations.stop();
assert.equal(batch.dropped, 1);
assert.equal(batch.observations[0].text, "second");
assert.equal(listeners.size, 0);
assert.deepEqual(await session.elementState(defineDomLocator({
  key: "fixture.action", kind: "testId", value: "action",
})), { present: true, visible: true, enabled: false, clickable: false });
assert.equal(disposed, true);
const artifact = await session.saveStorageState(path.resolve("state.json"), { indexedDB: true });
assert.equal(artifact.sensitive, true);
assert.deepEqual(JSON.parse(await readFile(artifact.sourcePath, "utf8")), {
  cookies: [], origins: [],
});
await session.close();
assert.equal(closed, 2);
await assert.rejects(session.title(), (error) =>
  error instanceof BrowserAutomationError && error.code === "sessionClosed");
await assert.rejects(import("@surfaceloom/browser-playwright/dist/session.js"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});
