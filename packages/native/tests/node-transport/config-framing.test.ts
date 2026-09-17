import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { snapshotNodeProcessOptions } from "../../src/node-transport/config.js";
import { StdoutFramer } from "../../src/node-transport/framer.js";
import { parseWireLine } from "../../src/framing.js";

const absolute = process.execPath;
const cwd = process.cwd();

test("configuration snapshots argv and env without inheriting the ambient environment", () => {
  const argv = ["space value", "quote'\"", "$HOME", "semi;colon"];
  const env = { FIXTURE_VALUE: "first" };
  const config = snapshotNodeProcessOptions({ executable: absolute, cwd, argv, env });
  argv[0] = "mutated";
  env.FIXTURE_VALUE = "mutated";
  assert.deepEqual(config.argv, ["space value", "quote'\"", "$HOME", "semi;colon"]);
  assert.deepEqual(config.env, { FIXTURE_VALUE: "first" });
  assert.equal(config.env.PATH, undefined);
  assert.ok(Object.isFrozen(config.argv));
  assert.ok(Object.isFrozen(config.env));
  const prototypeKey = Object.create(null) as Record<string, string>;
  prototypeKey.__proto__ = "plain-data";
  const safe = snapshotNodeProcessOptions({ executable: absolute, cwd, env: prototypeKey });
  assert.equal(safe.env.__proto__, "plain-data");
  assert.equal(Object.getPrototypeOf(safe.env), Object.prototype);
});

test("configuration rejects relative paths, script launchers, NUL, and accessor data", () => {
  assert.throws(() => snapshotNodeProcessOptions({ executable: "node", cwd }), /absolute paths/u);
  assert.throws(() => snapshotNodeProcessOptions({ executable: path.join(cwd, "host.CMD"), cwd }),
    /not supported/u);
  assert.throws(() => snapshotNodeProcessOptions({ executable: absolute, cwd, argv: ["bad\0arg"] }), /NUL/u);
  const env = Object.defineProperty({}, "TOKEN", { enumerable: true, get: () => "secret" });
  assert.throws(() => snapshotNodeProcessOptions({ executable: absolute, cwd, env }), /data properties/u);
});

test("Windows environment key identity is case-insensitive", () => {
  assert.throws(() => snapshotNodeProcessOptions({ executable: absolute, cwd,
    env: { Path: "one", PATH: "two" } }, "win32"), /collide/u);
});

test("options and nested containers reject proxies without invoking any trap", () => {
  let traps = 0;
  const proxy = new Proxy({}, {
    get: () => { traps += 1; throw new Error("get trap"); },
    getOwnPropertyDescriptor: () => { traps += 1; throw new Error("descriptor trap"); },
    getPrototypeOf: () => { traps += 1; throw new Error("prototype trap"); },
    ownKeys: () => { traps += 1; throw new Error("keys trap"); },
  });
  assert.throws(() => snapshotNodeProcessOptions(proxy as never), /plain data object/u);
  for (const field of ["argv", "env", "inheritEnvAllowlist"] as const) {
    assert.throws(() => snapshotNodeProcessOptions({ executable: absolute, cwd,
      [field]: proxy } as never), /plain/u);
  }
  assert.equal(traps, 0);
});

test("top-level option accessors are rejected without execution", () => {
  let getterCalls = 0;
  const options = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(options, "executable", { enumerable: true,
    get: () => { getterCalls += 1; return absolute; } });
  Object.defineProperty(options, "cwd", { enumerable: true, value: cwd });
  assert.throws(() => snapshotNodeProcessOptions(options as never), /data properties/u);
  assert.equal(getterCalls, 0);
});

test("each timeout accepts only the Node timer range", () => {
  for (const field of ["closeGraceMs", "startupTimeoutMs", "writeTimeoutMs", "forceCloseMs"] as const) {
    assert.equal(snapshotNodeProcessOptions({ executable: absolute, cwd, [field]: 0 })[field], 0);
    assert.equal(snapshotNodeProcessOptions({ executable: absolute, cwd,
      [field]: 2_147_483_647 })[field], 2_147_483_647);
    assert.throws(() => snapshotNodeProcessOptions({ executable: absolute, cwd,
      [field]: 2_147_483_648 }), new RegExp(`${field} is out of range`, "u"));
  }
});

test("framer handles bytewise UTF-8, CRLF, LF, and a complete EOF tail", () => {
  const frames: string[] = [];
  const framer = new StdoutFramer(64, (frame) => frames.push(frame));
  for (const byte of Buffer.from("猫\r\ndog\ntail", "utf8")) framer.push(Buffer.from([byte]));
  framer.end();
  assert.deepEqual(frames, ["猫\r\n", "dog\n", "tail"]);
});

test("framer ignores empty EOF and enforces the implicit-LF cap before decode", () => {
  const frames: string[] = [];
  const empty = new StdoutFramer(4, (frame) => frames.push(frame));
  empty.end();
  assert.deepEqual(frames, []);
  const exact = new StdoutFramer(4, (frame) => frames.push(frame));
  exact.push(Buffer.from("abc"));
  exact.end();
  assert.equal(frames.at(-1), "abc");
  const oversized = new StdoutFramer(4, () => assert.fail("must fail before emit"));
  assert.throws(() => oversized.push(Buffer.from("abcd")), /byte limit/u);
});

test("framer performs fatal UTF-8 decoding only after byte-size admission", () => {
  const invalid = new StdoutFramer(4, () => assert.fail("invalid UTF-8 must not emit"));
  assert.throws(() => invalid.push(Buffer.from([0xff, 0x0a])), /valid UTF-8/u);
  const tooLarge = new StdoutFramer(1, () => assert.fail("oversized input must not decode"));
  assert.throws(() => tooLarge.push(Buffer.from([0xff, 0x0a])), /byte limit/u);
});

test("framer preserves a UTF-8 BOM on the first and later frames for strict rejection", () => {
  const frames: string[] = [];
  const framer = new StdoutFramer(32, (frame) => frames.push(frame));
  framer.push(Buffer.from("\uFEFF{}\n\uFEFF[]\n", "utf8"));
  assert.deepEqual(frames, ["\uFEFF{}\n", "\uFEFF[]\n"]);
  for (const frame of frames) assert.throws(() => parseWireLine(frame), /valid JSON/u);
});
