import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WindowsNativeController } from "../../src/windows/controller.js";
import { WindowsNativeError } from "../../src/windows/error.js";
import type { WindowsControllerOptions, WindowsUiaLocator } from "../../src/windows/contracts.js";

const fixture = fileURLToPath(new URL("../fixtures/windows-v1-scripted-host.mjs", import.meta.url));
const cwd = path.dirname(fixture);
const target = path.resolve(cwd, "fixture-app.exe");
const field: WindowsUiaLocator = Object.freeze({ automationIds: Object.freeze(["fixture.name"]),
  names: Object.freeze([]), controlTypes: Object.freeze(["edit"]), classNames: Object.freeze([]),
  frameworkIds: Object.freeze([]), nativeWindowHandle: null, scope: "descendants", matchIndex: null });

test("scripted v1 controller preserves identities, checked actions, receipts, and idempotent end", async (t) => {
  const controller = controllerFor("ok");
  t.after(() => controller.close());
  const operation = Object.freeze({ timeoutMs: 30_000 });
  const connected = await controller.connect(operation.timeoutMs);
  assert.equal(connected.logicalHostId, "windows.scripted");
  assert.equal(connected.host.hostInstanceId, "windows-scripted-host");
  assert.notEqual(connected.childIdentity, connected.host.hostInstanceId);
  assert.ok(connected.effectiveCapabilities.includes("ui.invoke"));

  const session = await controller.launch({ executablePath: target, timeoutMs: operation.timeoutMs });
  assert.equal(session.targetIdentity, "windows-process:4242");
  const found = await session.find(field, operation);
  assert.equal(found.value.snapshot.automationId, "fixture.name");
  assert.equal((await session.get(found.value.handle, operation)).value.processId, 4242);
  assert.equal((await session.invoke(field, operation)).operation?.outcome, "executed");
  assert.equal((await session.setValue(field, "updated", operation)).operation?.outcome, "executed");
  const first = await session.lifecyclePort.quit(operation);
  const second = await session.lifecyclePort.quit(operation);
  assert.deepEqual(first, second);
  assert.equal(session.removed, true);
  assert.deepEqual(await session.cleanupPort.release(operation), { kind: "sessionRelease",
    hostInstanceId: "windows-scripted-host", sessionId: "windows-scripted-session" });
  assert.equal((await controller.close()).status, "exited");
});

test("borrowed attach verifies PID and never exposes destructive lifecycle", async () => {
  const controller = controllerFor("ok");
  await controller.connect();
  const session = await controller.attach({ processId: 4242, timeoutMs: 2_000 });
  assert.equal(session.ownership, "borrowed");
  assert.equal((await session.cleanupPort.release()).kind, "sessionRelease");
  await controller.close();

  const mismatch = controllerFor("wrong-pid");
  await mismatch.connect();
  await assert.rejects(mismatch.attach({ processId: 4242, timeoutMs: 2_000 }), (error: unknown) =>
    error instanceof WindowsNativeError && error.operationOutcome === "unknown");
  const recovered = await mismatch.reconcileLate("attach", 10);
  assert.equal(recovered?.targetIdentity, "windows-session:windows-scripted-session");
  await recovered?.cleanupPort.release();
  await mismatch.close();
});

test("unknown remote action retains its exact operation receipt", async () => {
  const controller = controllerFor("unknown-action");
  await controller.connect();
  const session = await controller.launch({ executablePath: target, timeoutMs: 2_000 });
  await assert.rejects(session.invoke(field), (error: unknown) => {
    assert.ok(error instanceof WindowsNativeError);
    assert.equal(error.operationOutcome, "unknown");
    assert.equal(error.operationReceipt?.outcome, "unknown");
    assert.match(error.operationReceipt?.operationId ?? "", /^windows-action-/u);
    return true;
  });
  await session.lifecyclePort.terminate();
  await controller.close();
});

test("local post-submit timeout retains its generated operation identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "surfaceloom-windows-operation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "wire.log");
  const controller = controllerFor("slow-action", marker);
  t.after(() => controller.close());
  await controller.connect();
  const session = await controller.launch({ executablePath: target, timeoutMs: 2_000 });
  await assert.rejects(session.invoke(field, { timeoutMs: 15 }), (error: unknown) => {
    assert.ok(error instanceof WindowsNativeError);
    assert.equal(error.operationOutcome, "unknown");
    assert.equal(error.operationReceipt?.outcome, "unknown");
    assert.match(error.operationReceipt?.operationId ?? "", /^windows-action-/u);
    return true;
  });
  assert.match(await readFile(marker, "utf8"), /element\.action/u);
  await controller.close();
});

test("unknown target end is terminal and cleanup never replays it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "surfaceloom-windows-end-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "wire.log");
  const controller = controllerFor("unknown-end", marker);
  await controller.connect();
  const session = await controller.launch({ executablePath: target, timeoutMs: 2_000 });
  for (const action of [() => session.lifecyclePort.terminate(),
    () => session.cleanupPort.targetExit()]) {
    await assert.rejects(action(), (error: unknown) =>
      error instanceof WindowsNativeError && error.operationOutcome === "unknown"
      && error.operationReceipt?.operationId.startsWith("windows-end-") === true);
  }
  const writes = (await readFile(marker, "utf8")).trim().split("\n");
  assert.deepEqual(writes, ["session.terminate"]);
  await controller.close();
});

for (const mode of ["bad-end-action", "bad-end-pid"] as const) {
  test(`${mode} cannot satisfy target cleanup identity`, async () => {
    const controller = controllerFor(mode);
    await controller.connect();
    const session = await controller.launch({ executablePath: target, timeoutMs: 2_000 });
    await assert.rejects(session.lifecyclePort.terminate(), (error: unknown) =>
      error instanceof WindowsNativeError && error.operationOutcome === "executed");
    await controller.close();
  });
}

test("host multi-match errors remain strict lookup failures", async () => {
  const controller = controllerFor("ambiguous-find");
  await controller.connect();
  const session = await controller.launch({ executablePath: target, timeoutMs: 2_000 });
  await assert.rejects(session.find(field), (error: unknown) =>
    error instanceof WindowsNativeError && error.operationOutcome === null);
  await session.lifecyclePort.terminate();
  await controller.close();
});

test("late acquisition is reconciled once and remains cleanup-addressable", async () => {
  const controller = controllerFor("late-acquisition");
  await controller.connect();
  await assert.rejects(controller.launch({ executablePath: target, timeoutMs: 5 }), (error: unknown) =>
    error instanceof WindowsNativeError && error.operationOutcome === "unknown");
  const late = await controller.reconcileLate("launch", 100);
  assert.equal(late?.ownership, "owned");
  assert.equal(late?.acquisitionReceipt.outcome, "executed");
  await late?.cleanupPort.targetExit();
  await controller.close();
});

for (const mode of ["wrong-platform", "wrong-version", "missing-action"] as const) {
  test(`${mode} handshake fails closed and closes its child`, async () => {
    const controller = controllerFor(mode);
    await assert.rejects(controller.connect(1_000));
    const exit = await controller.close();
    assert.notEqual(exit.status, "unconfirmed");
  });
}

function controllerFor(mode: string, marker?: string): WindowsNativeController {
  const options: WindowsControllerOptions = { hostId: "windows.scripted",
    process: { executable: process.execPath, cwd, argv: [fixture, mode, ...(marker === undefined ? [] : [marker])],
      closeGraceMs: 20, forceCloseMs: 500, startupTimeoutMs: 500 },
    environmentCapabilities: ["app.launch", "app.attach", "app.quit", "app.terminate",
      "ui.inspect", "ui.invoke", "ui.set-value"] };
  return new WindowsNativeController(options);
}
