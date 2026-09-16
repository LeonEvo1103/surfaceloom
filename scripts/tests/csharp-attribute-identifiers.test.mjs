import assert from "node:assert/strict";
import test from "node:test";

import { extractCSharpStaticStringAttributeNames } from "../validate-case-specs.mjs";

const sampleCaseNames = source =>
  extractCSharpStaticStringAttributeNames(source, "SampleCase");

test("C# scanner accepts Unicode namespace identifiers", () => {
  assert.deepEqual(sampleCaseNames([
    '[命名空间.SampleCase("unicode-qualified")] void Unicode() {}',
    '[𐐀.SampleCaseAttribute("astral-qualified")] void Astral() {}',
  ].join("\n")), ["unicode-qualified", "astral-qualified"]);
});

test("C# scanner decodes identifier escapes before matching attribute names", () => {
  const shortEscape = String.raw`[\u0053ampleCase("escaped-target")] void Short() {}`;
  const longEscape = String.raw`[\U00000053ampleCaseAttribute("long-escaped-target")] void Long() {}`;
  const ignoredFormatting = String.raw`[Sample\u200CCase("formatting-character")] void Format() {}`;
  assert.ok(shortEscape.includes(String.raw`\u0053`));
  assert.deepEqual(
    sampleCaseNames([shortEscape, longEscape, ignoredFormatting].join("\n")),
    ["escaped-target", "long-escaped-target", "formatting-character"],
  );
});

test("C# scanner fails closed on Unicode aliases for the target attribute", () => {
  assert.throws(
    () => sampleCaseNames(
      'using 别名 = 命名空间.SampleCaseAttribute;\n[别名("unicode alias")] void Test() {}',
    ),
    /must not be hidden behind a using alias/,
  );
  assert.throws(
    () => sampleCaseNames(String.raw`
      using Alias = 命名空间.\u0053ampleCaseAttribute;
      [Alias("escaped target alias")] void Test() {}
    `),
    /must not be hidden behind a using alias/,
  );
});

test("C# scanner rejects invalid identifier escapes and scalars", () => {
  for (const source of [
    String.raw`[\u12G4ampleCase("bad hex")] void Test() {}`,
    String.raw`[\uD800ampleCase("surrogate")] void Test() {}`,
    String.raw`[\U00110000ampleCase("large scalar")] void Test() {}`,
    String.raw`[\x53ampleCase("unsupported escape")] void Test() {}`,
    String.raw`[\u0031SampleCase("digit start")] void Test() {}`,
  ]) {
    assert.throws(
      () => sampleCaseNames(source),
      /invalid Unicode|unsupported escape|valid identifier start/,
    );
  }
});

test("Escaped prefixes do not make longer identifiers match", () => {
  assert.deepEqual(sampleCaseNames([
    String.raw`[\u0053ampleCaseExtra("near match")] void Near() {}`,
    '[SampleCase("exact")] void Exact() {}',
  ].join("\n")), ["exact"]);
});
