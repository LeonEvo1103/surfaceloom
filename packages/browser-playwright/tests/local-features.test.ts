import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PlaywrightBrowserBackend, type BrowserSession } from "../src/index.js";

const localTest = process.env.SURFACELOOM_BROWSER_SMOKE === "1" ? test : test.skip;

localTest("system Chrome observes readiness and replays exported storage", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "surfaceloom-feature-smoke-"));
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><button data-testid="disabled" disabled>Disabled</button>
      <p data-testid="stored"></p><script>
        document.querySelector('[data-testid=stored]').textContent =
          localStorage.getItem('fixture') || 'missing';
        localStorage.setItem('fixture', 'persisted');
        document.cookie = 'fixture=synthetic; SameSite=Lax';
        console.log('fixture-observation');
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address === "object");
  const backend = new PlaywrightBrowserBackend();
  let session: BrowserSession | undefined;
  let replay: BrowserSession | undefined;
  try {
    session = await backend.launch({ channel: "chrome", headless: true });
    const observation = session.observe();
    await session.startTrace();
    const url = `http://127.0.0.1:${address.port}/`;
    await session.navigate(url);
    assert.deepEqual(await session.elementState({
      key: "fixture.disabled", kind: "testId", value: "disabled",
    }), { present: true, visible: true, enabled: false, clickable: false });
    assert.deepEqual(await session.elementState({
      key: "fixture.missing", kind: "testId", value: "missing",
    }, { timeoutMs: 50 }), {
      present: false, visible: false, enabled: false, clickable: false,
    });
    const screenshot = await session.screenshot(path.join(directory, "page.png"));
    const trace = await session.stopTrace(path.join(directory, "trace.zip"));
    const state = await session.saveStorageState(path.join(directory, "state.json"));
    const exported = JSON.parse(await readFile(state.sourcePath, "utf8"));
    assert(exported.cookies.some((cookie: { name: string }) => cookie.name === "fixture"));
    if (process.platform !== "win32") {
      for (const artifact of [screenshot, trace, state]) {
        assert.equal((await stat(artifact.sourcePath)).mode & 0o777, 0o600);
      }
    }
    const batch = observation.stop();
    assert(batch.observations.some((event) =>
      event.kind === "consoleMessage" && event.text === "fixture-observation"));
    assert(batch.observations.some((event) => event.kind === "response" && event.requestId !== undefined));
    await session.close();
    replay = await backend.launch({
      channel: "chrome", headless: true, context: { storageStatePath: state.sourcePath },
    });
    await replay.navigate(url);
    assert.equal(await replay.text({
      key: "fixture.stored", kind: "testId", value: "stored",
    }), "persisted");
  } finally {
    await replay?.close();
    await session?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
