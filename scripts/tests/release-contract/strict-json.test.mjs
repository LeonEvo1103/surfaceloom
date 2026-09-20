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
  const [planV1, manifestV1, planV2, manifestV2, common] = await Promise.all([
    schema("release-plan.schema.json"), schema("release-manifest.schema.json"),
    schema("release-plan-v2.schema.json"), schema("release-manifest-v2.schema.json"),
    schema("release-common.schema.json"),
  ]);
  for (const schema of [planV1, manifestV1, planV2, manifestV2]) {
    assert.equal(schema.additionalProperties, false);
  }
  assert.equal(planV1.properties.schemaVersion.const, "surfaceloom.release-plan/1");
  assert.equal(manifestV1.properties.schemaVersion.const, "surfaceloom.release-manifest/1");
  assert.equal(planV2.properties.schemaVersion.const, "surfaceloom.release-plan/2");
  assert.equal(manifestV2.properties.schemaVersion.const, "surfaceloom.release-manifest/2");
  assert.deepEqual([
    planV1.properties.packages.minItems, planV1.properties.packages.maxItems,
    manifestV1.properties.packages.minItems, manifestV1.properties.packages.maxItems,
    planV2.properties.packages.minItems, planV2.properties.packages.maxItems,
    manifestV2.properties.packages.minItems, manifestV2.properties.packages.maxItems,
  ], [7, 7, 7, 7, 9, 9, 9, 9]);
  for (const [schema, count] of [
    [planV1, 7], [manifestV1, 7], [planV2, 9], [manifestV2, 9],
  ]) {
    assert.equal(schema.properties.packageBuildOrder.minItems, count);
    assert.equal(schema.properties.packageBuildOrder.maxItems, count);
  }
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
