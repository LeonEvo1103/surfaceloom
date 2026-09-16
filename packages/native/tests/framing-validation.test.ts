import assert from "node:assert/strict";
import test from "node:test";
import {
  maxDeadlineMs, maxWireMessageBytes, NativeProtocolError, parseWireLine, validateWireMessage,
  wireDeadlinePolicy,
} from "../src/index.js";

const valid = () => ({
  protocol: "surfaceloom.native", version: "1.0", type: "request", id: "request-1",
  deadline: { timeoutMs: 1000 }, call: {
    name: "host.handshake", intent: "observe", scope: { kind: "bootstrap" }, payload: {},
  },
});

test("framing accepts one object with LF or CRLF and rejects multiple/empty frames", () => {
  const line = JSON.stringify(valid());
  assert.doesNotThrow(() => parseWireLine(line));
  assert.doesNotThrow(() => parseWireLine(`${line}\n`));
  assert.doesNotThrow(() => parseWireLine(`${line}\r\n`));
  for (const frame of ["", "\n", `${line}\n${line}\n`]) {
    assert.throws(() => parseWireLine(frame), (error: unknown) =>
      error instanceof NativeProtocolError && error.code === "invalid_frame");
  }
  assert.throws(() => parseWireLine("{"), (error: unknown) =>
    error instanceof NativeProtocolError && error.code === "invalid_json");
});

test("frame byte limit is enforced before JSON parsing", () => {
  const oversized = "{".repeat(maxWireMessageBytes + 1);
  assert.throws(() => parseWireLine(oversized), (error: unknown) =>
    error instanceof NativeProtocolError && error.code === "message_too_large");
  const delimiterStrippedAtLimit = "{".repeat(maxWireMessageBytes);
  assert.throws(() => parseWireLine(delimiterStrippedAtLimit), (error: unknown) =>
    error instanceof NativeProtocolError && error.code === "message_too_large");
  const delimitedAtLimit = `${"{".repeat(maxWireMessageBytes - 1)}\n`;
  assert.throws(() => parseWireLine(delimitedAtLimit), (error: unknown) =>
    error instanceof NativeProtocolError && error.code === "invalid_json");
});

test("deadline is relative, finite, and bounded including zero", () => {
  assert.doesNotThrow(() => validateWireMessage({ ...valid(), deadline: { timeoutMs: 0 } }));
  assert.doesNotThrow(() => validateWireMessage({ ...valid(), deadline: { timeoutMs: maxDeadlineMs } }));
  for (const timeoutMs of [-1, 1.5, Number.NaN, maxDeadlineMs + 1]) {
    assert.throws(() => validateWireMessage({ ...valid(), deadline: { timeoutMs } }), /integer between/);
  }
});

test("deadline starts at complete-frame arrival and covers validation through response", () => {
  assert.deepEqual(wireDeadlinePolicy, {
    startsAt: "frameReceived",
    covers: ["protocolValidation", "schemaValidation", "queue", "operation", "response"],
  });
  assert.ok(Object.isFrozen(wireDeadlinePolicy));
  assert.ok(Object.isFrozen(wireDeadlinePolicy.covers));
});

test("cancellation ids are distinct and bounded", () => {
  const cancel = { protocol: "surfaceloom.native", version: "1.0", type: "cancel",
    id: "cancel-1", requestId: "request-1", reason: "caller" };
  assert.doesNotThrow(() => validateWireMessage(cancel));
  assert.throws(() => validateWireMessage({ ...cancel, id: "request-1" }), /must differ/);
  assert.throws(() => validateWireMessage({ ...cancel, reason: "completed" }), /supported value/);
});

test("schema rejects extra fields, accessors, functions, and non-finite JSON", () => {
  assert.throws(() => validateWireMessage({ ...valid(), method: "legacy" }), /unknown field/);
  assert.throws(() => validateWireMessage({ ...valid(), call: { ...valid().call, payload: { value: undefined } } }),
    /JSON values/);
  assert.throws(() => validateWireMessage({ ...valid(), call: { ...valid().call, payload: { value: Infinity } } }),
    /JSON values/);
  let reads = 0;
  const hostile = { ...valid(), get id() { reads += 1; return "request-1"; } };
  assert.throws(() => validateWireMessage(hostile), /enumerable data field/);
  assert.equal(reads, 0);
  let arrayReads = 0;
  const hostileArray = ["safe"];
  Object.defineProperty(hostileArray, "0", {
    enumerable: true,
    get() { arrayReads += 1; return "leak"; },
  });
  assert.throws(() => validateWireMessage({ ...valid(), call: {
    ...valid().call, payload: { values: hostileArray },
  } }), /enumerable data item/);
  assert.equal(arrayReads, 0);
});

test("unsupported protocol and version remain distinct from malformed messages", () => {
  assert.throws(() => validateWireMessage({ ...valid(), protocol: "vendor.native" }),
    (error: unknown) => error instanceof NativeProtocolError && error.code === "unsupported_protocol");
  assert.throws(() => validateWireMessage({ ...valid(), version: "1.1" }),
    (error: unknown) => error instanceof NativeProtocolError && error.code === "unsupported_version");
});
