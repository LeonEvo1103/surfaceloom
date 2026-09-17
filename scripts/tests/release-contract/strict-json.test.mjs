import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseStrictJson, StrictJsonError } from "../../release/strict-json.mjs";
import { validateReleaseManifestJson } from "../../release/release-manifest.mjs";

test("strict JSON rejects duplicate decoded keys instead of using last-key-wins", async () => {
  const text = await readFile(new URL("./fixtures/duplicate-key.json", import.meta.url), "utf8");
  assert.throws(() => parseStrictJson(text), (error) =>
    error instanceof StrictJsonError && error.code === "duplicateKey");
  assert.throws(() => validateReleaseManifestJson(text, undefined), (error) =>
    error instanceof StrictJsonError && error.code === "duplicateKey");
});

test("strict JSON rejects trailing bytes, malformed escapes, and excessive nesting", () => {
  assert.throws(() => parseStrictJson("{}{}"), code("trailingData"));
  assert.throws(() => parseStrictJson('{"x":"\\u0xx0"}'), code("invalidString"));
  assert.throws(() => parseStrictJson("[[[]]]", { maxDepth: 1 }), code("tooDeep"));
});

test("release schemas are independently versioned strict top-level objects", async () => {
  const [plan, manifest, common] = await Promise.all([
    schema("release-plan.schema.json"), schema("release-manifest.schema.json"),
    schema("release-common.schema.json"),
  ]);
  assert.equal(plan.additionalProperties, false);
  assert.equal(manifest.additionalProperties, false);
  assert.equal(plan.properties.schemaVersion.const, "surfaceloom.release-plan/1");
  assert.equal(manifest.properties.schemaVersion.const, "surfaceloom.release-manifest/1");
  for (const definition of Object.values(common.$defs)) {
    if (definition.type === "object" && definition !== common.$defs.stringMap
        && definition !== common.$defs.jsonValue) assert.equal(definition.additionalProperties, false);
  }
});

async function schema(name) {
  return parseStrictJson(await readFile(new URL(`../../../docs/release/${name}`, import.meta.url), "utf8"));
}

function code(value) {
  return (error) => error instanceof StrictJsonError && error.code === value;
}
