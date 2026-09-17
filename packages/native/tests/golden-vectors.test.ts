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
  readonly message: unknown;
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
  ]);
});

for (const filename of vectors) {
  const vector = JSON.parse(readFileSync(join(vectorDirectory, filename), "utf8")) as Vector;
  test(`golden: ${vector.name}`, () => {
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
