import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCSharpStaticStringAttributeNames,
  extractSwiftTestDisplayNames,
} from "../validate-case-specs.mjs";

const lines = (...items) => items.join("\n");
const swiftNames = extractSwiftTestDisplayNames;
const csharpNames = source =>
  extractCSharpStaticStringAttributeNames(source, "SurfaceLoomCase");
const sampleCaseNames = source =>
  extractCSharpStaticStringAttributeNames(source, "SampleCase");

test("Swift scanner excludes nested #if false branches and selects #elseif/#else", () => {
  assert.deepEqual(swiftNames(lines(
    "#if false",
    '@Test("disabled outer") func disabledOuter() {}',
    "#if unknown_nested_condition",
    '@Test("disabled nested unknown") func disabledNestedUnknown() {}',
    "#endif",
    "#elseif true && !false",
    '@Test("active elseif") func activeElseif() {}',
    "#if false",
    '@Test("disabled nested") func disabledNested() {}',
    "#else",
    '@Test("active nested else") func activeNestedElse() {}',
    "#endif",
    "#else",
    '@Test("disabled else") func disabledElse() {}',
    "#endif",
  )), ["active elseif", "active nested else"]);
});

test("C# scanner excludes nested #if false branches and selects #elif/#else", () => {
  assert.deepEqual(csharpNames(lines(
    "#if false",
    '[SurfaceLoomCase("disabled outer")] void DisabledOuter() {}',
    "#if UNKNOWN_NESTED_CONDITION",
    '[SurfaceLoomCase("disabled nested unknown")] void DisabledNestedUnknown() {}',
    "#endif",
    "#elif true && !false",
    '[SurfaceLoomCase("active elif")] void ActiveElif() {}',
    "#if false",
    '[SurfaceLoomCase("disabled nested")] void DisabledNested() {}',
    "#else",
    '[SurfaceLoomCase("active nested else")] void ActiveNestedElse() {}',
    "#endif",
    "#else",
    '[SurfaceLoomCase("disabled else")] void DisabledElse() {}',
    "#endif",
  )), ["active elif", "active nested else"]);
});

test("disabled branches may contain invalid text without creating mappings", () => {
  assert.deepEqual(swiftNames(lines(
    "#if false",
    '"unterminated disabled string',
    '@Test("disabled")',
    "#endif",
    '@Test("active Swift") func active() {}',
  )), ["active Swift"]);
  assert.deepEqual(csharpNames(lines(
    "#if false",
    '"unterminated disabled string',
    '[SurfaceLoomCase("disabled")]',
    "#endif",
    '[SurfaceLoomCase("active C#")] void Active() {}',
  )), ["active C#"]);
});

test("conditional compilation rejects unknown conditions and malformed structure", () => {
  assert.throws(
    () => swiftNames(lines(
      "#if canImport(Testing)",
      '@Test("uncertain") func uncertain() {}',
      "#endif",
    )),
    /cannot (?:parse|statically evaluate) conditional expression/,
  );
  assert.throws(
    () => csharpNames(lines(
      "#if WINDOWS",
      '[SurfaceLoomCase("uncertain")] void Test() {}',
      "#endif",
    )),
    /cannot statically evaluate conditional expression/,
  );
  assert.throws(
    () => swiftNames(lines("#if true", '@Test("unterminated") func test() {}')),
    /unterminated #if block/,
  );
  assert.throws(
    () => csharpNames(lines("#else", '[SurfaceLoomCase("stray")] void Test() {}')),
    /unexpected #else/,
  );
  assert.throws(
    () => swiftNames(lines("#if false", "#elif true", "#endif")),
    /unsupported #elif; expected #elseif/,
  );
  assert.throws(
    () => csharpNames(lines("#if false", "#elseif true", "#endif")),
    /unsupported #elseif; expected #elif/,
  );
});

test("Swift scanner ignores @Test text in regexes and interpolated strings", () => {
  assert.deepEqual(swiftNames(lines(
    'let bare = /@Test("fake bare regex")/',
    'let extended = #/@Test("fake extended regex")/#',
    'let interpolated = "prefix \\(render("@Test(fake nested string)")) suffix"',
    'let regexInterpolation = "prefix \\(#/@Test("fake nested regex")/#) suffix"',
    'let multiline = """',
    '  @Test("fake multiline string")',
    '  """',
    '@Test("real Swift test") func real() {}',
  )), ["real Swift test"]);
});

test("Swift @Test display names remain static with interpolation lexing", () => {
  assert.throws(
    () => swiftNames('@Test("name \\(suffix)") func dynamic() {}'),
    /must not use interpolation/,
  );
});

test("C# scanner ignores attributes in interpolated and C# 11 raw strings", () => {
  assert.deepEqual(csharpNames(lines(
    'var ordinary = $"[SurfaceLoomCase(fake ordinary interpolated)] {value}";',
    'var nested = $"prefix {Render("[SurfaceLoomCase(fake nested)]")} suffix";',
    'var verbatim = $@"[SurfaceLoomCase(fake verbatim interpolated)] {value}";',
    'var reversePrefix = @$"[SurfaceLoomCase(fake reverse prefix)] {value}";',
    'var raw = """[SurfaceLoomCase("fake raw")]""";',
    'var interpolatedRaw = $"""[SurfaceLoomCase("fake interpolated raw")] {value}""";',
    'var doubleInterpolatedRaw = $$"""[SurfaceLoomCase("fake double raw")] {{value}}""";',
    '[SurfaceLoomCase("real C# test")] void Real() {}',
  )), ["real C# test"]);
});

test("C# scanner accepts Attribute suffixes and qualified attribute type names", () => {
  assert.deepEqual(sampleCaseNames(lines(
    '[SampleCaseAttribute("suffix")] void Suffix() {}',
    '[Example.SampleCase("qualified")] void Qualified() {}',
    '[global::Example.SampleCaseAttribute("global qualified")] void Global() {}',
    '[Alias::Example.Deep.@SampleCase("alias qualified")] void Alias() {}',
  )), ["suffix", "qualified", "global qualified", "alias qualified"]);

  assert.deepEqual(
    extractCSharpStaticStringAttributeNames(
      '[Example.SampleCase("configured with suffix")] void Test() {}',
      "SampleCaseAttribute",
    ),
    ["configured with suffix"],
  );
});

test("C# scanner rejects qualified near matches and keeps static arguments fail-closed", () => {
  assert.deepEqual(sampleCaseNames(lines(
    '[SampleCaseExtra("longer base identifier")] void A() {}',
    '[SampleCaseAttributeExtra("longer suffixed identifier")] void B() {}',
    '[PrefixSampleCase("prefixed identifier")] void C() {}',
    '[Example.SampleCaseExtra("qualified near match")] void D() {}',
    '[SampleCase.Member("non-terminal match")] void E() {}',
    '[Example.SampleCase("real qualified")] void Real() {}',
  )), ["real qualified"]);
  assert.throws(
    () => sampleCaseNames('[global::Example.SampleCaseAttribute(nameof(Test))] void Test() {}'),
    /static single-line string/,
  );
});

test("C# scanner rejects a target attribute later in a grouped attribute list", () => {
  assert.throws(
    () => sampleCaseNames('[Obsolete, SampleCase("grouped second")] void Test() {}'),
    /standalone attribute/,
  );
  assert.throws(
    () => sampleCaseNames(
      '[One("comma, inside"), global::Example.SampleCaseAttribute("grouped third")] void Test() {}',
    ),
    /standalone attribute/,
  );
});

test("C# scanner fails closed on attribute target specifiers", () => {
  for (const source of [
    '[method: SampleCase("method target")] void Test() {}',
    '[return: global::Example.SampleCaseAttribute("return target")] string Test() => "";',
    '[method: Obsolete, Example.SampleCase("grouped target")] void Test() {}',
  ]) {
    assert.throws(() => sampleCaseNames(source), /must not use an attribute target specifier/);
  }

  assert.deepEqual(
    sampleCaseNames('[method: Obsolete] void Ignored() {}\n[SampleCase("plain")] void Plain() {}'),
    ["plain"],
  );
});

test("C# scanner fails closed on using aliases for the target attribute", () => {
  for (const source of [
    'using Case = Example.SampleCaseAttribute;\n[Case("alias")] void Test() {}',
    'using Case = global::Example.SampleCase;\n[Case("global alias")] void Test() {}',
    'global using Case = Alias::Example.@SampleCaseAttribute;\n[Case("extern alias")] void Test() {}',
    'global using unsafe Case = global::Example.SampleCaseAttribute;\n[Case("unsafe alias")] void Test() {}',
  ]) {
    assert.throws(() => sampleCaseNames(source), /must not be hidden behind a using alias/);
  }

  assert.deepEqual(sampleCaseNames(lines(
    'var text = "using Case = Example.SampleCaseAttribute;";',
    'using OtherCase = Example.SampleCaseAttributeExtra;',
    '[Example.SampleCase("explicit target")] void Test() {}',
  )), ["explicit target"]);
});

test("directive-looking lines inside multiline literals do not alter active state", () => {
  assert.deepEqual(swiftNames(lines(
    'let text = """',
    "#if false",
    '@Test("fake in Swift multiline literal")',
    "#endif",
    '"""',
    '@Test("real after Swift literal") func real() {}',
  )), ["real after Swift literal"]);
  assert.deepEqual(csharpNames(lines(
    'var text = """',
    "#if false",
    '[SurfaceLoomCase("fake in C# raw literal")]',
    "#endif",
    '""";',
    '[SurfaceLoomCase("real after C# literal")] void Real() {}',
  )), ["real after C# literal"]);
});
