import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { encodeWireLine, NativeProtocolError, parseWireLine, validateWireMessage } from "../src/index.js";

interface Vector {
  readonly name: string;
  readonly valid: boolean;
  readonly errorCode?: string;
  readonly expectedPayloadKeyUtf8Hex?: readonly string[];
  readonly rawValid?: boolean;
  readonly rawContainerDepth?: number;
  readonly message?: unknown;
  readonly wire?: string;
}

const vectorDirectory = join(dirname(fileURLToPath(import.meta.url)), "../vectors/v1");
const vectors = readdirSync(vectorDirectory).filter((name) => name.endsWith(".vector.json")).sort();

test("v1 golden vector inventory is stable and non-empty", () => {
  assert.deepEqual(vectors, [
    "01-handshake-request.vector.json", "02-handshake-response.vector.json",
    "03-session-launch.vector.json", "04-session-launch-response.vector.json",
    "05-handle-observe.vector.json", "06-action-not-executed.vector.json",
    "07-action-unknown.vector.json", "08-cancel.vector.json",
    "09-windows-02-not-shared.vector.json", "10-unsupported-version.vector.json",
    "11-duplicate-json-key.vector.json",
    "12-payload-depth-32.vector.json", "13-payload-depth-33.vector.json",
    "14-result-depth-32.vector.json", "15-result-depth-33.vector.json",
    "16-details-depth-32.vector.json", "17-details-depth-33.vector.json",
    "18-canonical-equivalent-keys.vector.json", "19-escaped-high-surrogate.vector.json",
    "20-escaped-low-surrogate.vector.json",
    "21-raw-array-depth-64-empty.vector.json", "22-raw-array-depth-64-value.vector.json",
    "23-raw-array-depth-65-empty.vector.json", "24-raw-array-depth-65-value.vector.json",
    "25-raw-object-depth-64-empty.vector.json", "26-raw-object-depth-64-value.vector.json",
    "27-raw-object-depth-65-empty.vector.json", "28-raw-object-depth-65-value.vector.json",
  ]);
});

for (const filename of vectors) {
  const vector = JSON.parse(readFileSync(join(vectorDirectory, filename), "utf8")) as Vector;
  test(`golden: ${vector.name}`, () => {
    if (vector.wire !== undefined) {
      const wire = vector.wire;
      if (vector.rawValid !== undefined) {
        assert.equal(vector.valid, false);
        assert.equal(vector.rawContainerDepth, vector.rawValid ? 64 : 65);
        assert.throws(() => parseWireLine(wire), (error: unknown) =>
          error instanceof NativeProtocolError && error.code === vector.errorCode);
        return;
      }
      if (!vector.valid) {
        assert.throws(() => parseWireLine(wire), (error: unknown) =>
          error instanceof NativeProtocolError && error.code === vector.errorCode);
        return;
      }
      const checked = parseWireLine(wire);
      if (vector.expectedPayloadKeyUtf8Hex !== undefined) {
        assert.equal(checked.type, "request");
        if (checked.type !== "request") return;
        assert.deepEqual(Object.keys(checked.call.payload).map((key) => Buffer.from(key).toString("hex")),
          vector.expectedPayloadKeyUtf8Hex);
      }
      assert.deepEqual(parseWireLine(encodeWireLine(checked)), checked);
      return;
    }
    if (!vector.valid) {
      assert.throws(() => validateWireMessage(vector.message), (error: unknown) =>
        error instanceof NativeProtocolError && error.code === vector.errorCode);
      return;
    }
    const checked = validateWireMessage(vector.message);
    const encoded = encodeWireLine(checked);
    assert.equal(encoded.endsWith("\n"), true);
    assert.deepEqual(parseWireLine(encoded), checked);
    assert.ok(Object.isFrozen(checked));
  });
}
