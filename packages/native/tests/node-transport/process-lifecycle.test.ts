import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NativeTransportWriteError } from "../../src/client/index.js";
import {
  NodeChildProcessTransport, NodeProcessTransportError, type NodeProcessTransportOptions,
} from "../../src/node-transport/index.js";

const fixture = fileURLToPath(new URL("../fixtures/node-transport-host.mjs", import.meta.url));
const loadedProcessDeadlineMs = 30_000;

function transport(mode: string, args: readonly string[] = [],
  overrides: Partial<NodeProcessTransportOptions> = {}): NodeChildProcessTransport {
  return new NodeChildProcessTransport({ executable: process.execPath, cwd: process.cwd(),
    argv: [fixture, mode, ...args], closeGraceMs: 25,
    startupTimeoutMs: loadedProcessDeadlineMs, writeTimeoutMs: loadedProcessDeadlineMs,
    ...overrides });
}

async function collect(mode: string, args: readonly string[] = [],
  overrides: Partial<NodeProcessTransportOptions> = {}): Promise<{
    readonly instance: NodeChildProcessTransport; readonly frames: readonly string[];
    readonly disconnects: number;
  }> {
  const instance = transport(mode, args, overrides);
  const frames: string[] = [];
  let disconnects = 0;
  let disconnected!: () => void;
  const disconnectedPromise = new Promise<void>((resolve) => { disconnected = resolve; });
  await instance.open({ onFrame: (frame) => frames.push(frame), onDisconnect: () => {
    disconnects += 1;
    disconnected();
  } });
  await disconnectedPromise;
  await instance.close();
  return { instance, frames, disconnects };
}

test("real spawn preserves special argv as data with shell disabled", async () => {
  const values = ["space value", "quote'\"", "$HOME", "semi;colon", "line\nbreak"];
  const result = await collect("argv", values);
  assert.deepEqual(JSON.parse(result.frames[0] ?? "[]"), values);
  assert.equal(result.disconnects, 1);
  assert.equal(result.instance.snapshot().exit?.code, 0);
});

test("real stdout supports multibyte byte chunks, CRLF, and EOF tail", async () => {
  const content = Buffer.from("猫\r\ndog\ntail", "utf8").toString("base64");
  const result = await collect("bytewise", [content]);
  assert.deepEqual(result.frames, ["猫\r\n", "dog\n", "tail"]);
});

test("real stdout cap and invalid UTF-8 fail once before frame delivery", async () => {
  const cap = await collect("raw", [Buffer.from("abcd\n").toString("base64")], { maxFrameBytes: 4 });
  assert.deepEqual(cap.frames, []);
  assert.equal(cap.disconnects, 1);
  const invalid = await collect("raw", [Buffer.concat([
    Buffer.from([0xff, 0x0a]), Buffer.from("must-not-emit\n"),
  ]).toString("base64")]);
  assert.deepEqual(invalid.frames, []);
  assert.equal(invalid.disconnects, 1);
});

test("stderr is continuously drained, bounded, and redacted alongside stdout", async () => {
  const result = await collect("stderr-flood", [], { maxStderrBytes: 256 });
  const snapshot = result.instance.snapshot();
  assert.deepEqual(result.frames, ["ready\n"]);
  assert.ok(snapshot.stderrBytesSeen > 100_000);
  assert.ok(Buffer.byteLength(snapshot.stderrTail, "utf8") <= 256);
  assert.doesNotMatch(snapshot.stderrTail, /do-not-retain/u);
  assert.match(snapshot.stderrTail, /REDACTED/u);
  assert.equal(snapshot.stderrTruncated, true);
  const both = await collect("both");
  assert.deepEqual(both.frames, ["one\n", "two\n"]);
  assert.doesNotMatch(both.instance.snapshot().stderrTail, /hunter2/u);
  const tiny = await collect("stderr-long-split", [], { maxStderrBytes: 4 });
  assert.ok(Buffer.byteLength(tiny.instance.snapshot().stderrTail, "utf8") <= 4);
  assert.doesNotMatch(tiny.instance.snapshot().stderrTail, /suffix|sensitive|x/u);
  const unicode = await collect("stderr-unicode", [], { maxStderrBytes: 4 });
  assert.equal(Buffer.byteLength(unicode.instance.snapshot().stderrTail, "utf8"), 3);
  assert.equal(unicode.instance.snapshot().stderrTail, "猫");
});

test("write admission rejects before write when an accepted frame owns the cap", async () => {
  const instance = transport("no-read", [], { maxOutstandingWriteBytes: 512 * 1024 });
  await instance.open({ onFrame: () => {}, onDisconnect: () => {} });
  const first = instance.write("x".repeat(512 * 1024));
  const observedFirst = first.catch((error: unknown) => error);
  await assert.rejects(instance.write("next\n"), (error: unknown) =>
    error instanceof NativeTransportWriteError && error.phase === "beforeWrite");
  const closing = instance.close();
  await closing;
  const firstResult = await observedFirst;
  if (firstResult instanceof Error) {
    assert.ok(firstResult instanceof NativeTransportWriteError);
    assert.equal(firstResult.phase, "writing");
  }
  assert.equal(instance.snapshot().outstandingWriteBytes, 0);
});

test("a write callback is not a process-exit receipt", async () => {
  const instance = transport("echo", [], { closeGraceMs: 500 });
  const frames: string[] = [];
  await instance.open({ onFrame: (frame) => frames.push(frame), onDisconnect: () => {} });
  await instance.write("hello\n");
  let exited = false;
  const exit = instance.waitForExit().then((receipt) => { exited = true; return receipt; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(exited, false);
  await instance.close();
  const receipt = await exit;
  assert.equal(receipt.status, "exited");
  if (receipt.status === "exited") assert.equal(receipt.code, 0);
  assert.deepEqual(frames, ["hello\n"]);
});

test("a crash during an accepted large write is conservatively writing", async () => {
  const instance = transport("crash-on-data", [], { maxOutstandingWriteBytes: 2 * 1_048_576 });
  await instance.open({ onFrame: () => {}, onDisconnect: () => {} });
  await assert.rejects(instance.write("x".repeat(1_048_576)), (error: unknown) =>
    error instanceof NativeTransportWriteError && error.phase === "writing");
  await instance.close();
  assert.equal(instance.snapshot().exit?.code, 23);
});

test("write deadline rejects only as writing and closes the blocked transport", async () => {
  const instance = transport("no-read", [], { maxOutstandingWriteBytes: 1_048_576,
    writeTimeoutMs: 10, closeGraceMs: 0, forceCloseMs: 200 });
  let disconnects = 0;
  await instance.open({ onFrame: () => {}, onDisconnect: () => { disconnects += 1; } });
  await assert.rejects(instance.write("x".repeat(512 * 1024)), (error: unknown) =>
    error instanceof NativeTransportWriteError && error.phase === "writing");
  await instance.close();
  assert.equal(disconnects, 1);
  assert.equal(instance.snapshot().outstandingWriteBytes, 0);
});

test("zero startup deadline rejects open and reaps a late child generation", async () => {
  const instance = transport("slow-eof", [], { startupTimeoutMs: 0, closeGraceMs: 10, forceCloseMs: 200 });
  await assert.rejects(instance.open({ onFrame: () => {}, onDisconnect: () => {} }),
    (error: unknown) => error instanceof NodeProcessTransportError && error.code === "startup_timeout");
  await instance.close();
  const receipt = await instance.waitForExit();
  assert.notEqual(receipt.status, "notSpawned");
  assert.equal(instance.snapshot().stdioClosed, true);
});

test("exit receipt is independent while force-close caches one stdio failure", async () => {
  const instance = transport("inherited-stdio", [], { closeGraceMs: 0, forceCloseMs: 20 });
  let ready!: () => void;
  const readyFrame = new Promise<void>((resolve) => { ready = resolve; });
  await instance.open({ onFrame: (frame) => { if (frame === "ready\n") ready(); }, onDisconnect: () => {} });
  await readyFrame;
  const receipt = await instance.waitForExit();
  assert.equal(receipt.status, "exited");
  assert.equal(instance.snapshot().processExitObserved, true);
  assert.equal(instance.snapshot().stdioClosed, false);
  const started = Date.now();
  const first = instance.close();
  const second = instance.close();
  assert.strictEqual(first, second);
  let firstError: unknown;
  await assert.rejects(first, (error: unknown) => {
    firstError = error;
    return error instanceof NodeProcessTransportError && error.code === "close_unconfirmed";
  });
  await assert.rejects(second, (error: unknown) => error === firstError);
  assert.ok(Date.now() - started < 300);
  assert.ok(Object.isFrozen(receipt));
  const snapshot = instance.snapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.equal(snapshot.spawned, true);
  assert.equal(snapshot.exit, receipt);
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(instance.snapshot().stdioClosed, true);
  assert.strictEqual(instance.close(), first);
  await assert.rejects(instance.close(), (error: unknown) => error === firstError);
});

test("spawn error settles open, exit wait, and close without duplicate disconnect", async () => {
  const instance = new NodeChildProcessTransport({ executable: "/definitely/missing/native-host",
    cwd: process.cwd() });
  let disconnects = 0;
  await assert.rejects(instance.open({ onFrame: () => {}, onDisconnect: () => { disconnects += 1; } }),
    (error: unknown) => error instanceof NodeProcessTransportError && error.code === "spawn_failed");
  assert.deepEqual(await instance.waitForExit(), { status: "notSpawned" });
  await instance.close();
  assert.equal(disconnects, 0);
});

test("crash and early stdout close disconnect once and produce real exit receipts", async () => {
  const crashing = transport("crash-on-data");
  let crashDisconnects = 0;
  await crashing.open({ onFrame: () => {}, onDisconnect: () => { crashDisconnects += 1; } });
  const write = crashing.write("request\n");
  await write.catch(() => {});
  const receipt = await crashing.waitForExit();
  await crashing.close();
  assert.equal(receipt.status, "exited");
  if (receipt.status === "exited") {
    assert.equal(receipt.code, 23);
    assert.equal(receipt.childInstanceId, crashing.snapshot().childInstanceId);
  }
  assert.equal(crashDisconnects, 1);
  const early = await collect("stdout-close");
  assert.equal(early.disconnects, 1);
  assert.notEqual(early.instance.snapshot().exit, null);
});

test("exit does not discard buffered stdout, including an EOF tail", async () => {
  const result = await collect("buffered-exit");
  assert.deepEqual(result.frames, ["first\n", "second-tail"]);
  assert.equal(result.instance.snapshot().exit?.code, 0);
});

test("close is one shared promise, ends stdin, then waits for true process close", async () => {
  const instance = transport("slow-eof", [], { closeGraceMs: 500 });
  await instance.open({ onFrame: () => {}, onDisconnect: () => {} });
  const started = Date.now();
  const first = instance.close();
  const second = instance.close();
  assert.strictEqual(first, second);
  await first;
  assert.ok(Date.now() - started >= 100);
  assert.equal(instance.snapshot().exit?.code, 0);
  assert.equal(instance.snapshot().state, "closed");
});

test("concurrent open and close settle once, and grace expiry waits for killed exit", async () => {
  const instance = transport("no-read", [], { closeGraceMs: 10 });
  const opening = instance.open({ onFrame: () => {}, onDisconnect: () => {} });
  const closing = instance.close();
  await assert.rejects(opening, /closed while opening/u);
  await closing;
  const receipt = await instance.waitForExit();
  assert.equal(receipt.status, "exited");
  if (receipt.status === "exited") assert.equal(receipt.signal, "SIGKILL");
  assert.equal(instance.snapshot().state, "closed");
});
