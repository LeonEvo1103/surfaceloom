import assert from "node:assert/strict";
import test from "node:test";

import {
  extractCSharpStaticStringAttributeNames,
  extractSwiftTestDisplayNames,
  parseCaseSpecCliArguments,
  validateCaseSpecSources,
} from "../validate-case-specs.mjs";

const extractSampleCSharpCaseNames = source =>
  extractCSharpStaticStringAttributeNames(source, "SurfaceLoomCase");

const sourceName = "Window closes and can be restored";
const validSpec = {
  id: "sample.lifecycle.window-roundtrip",
  locale: "zh-CN",
  platforms: ["macos"],
  suite: { id: "app.lifecycle", name: "应用生命周期" },
  name: "关闭窗口后可以恢复",
  sourceName,
  intent: "验证关闭主窗口不会误退出应用，并且用户仍可恢复窗口。",
  preconditions: [
    { id: "window-visible", text: "测试拥有的应用实例已显示唯一主窗口。" },
  ],
  acceptanceCriteria: [
    { id: "window-restored", text: "重新打开后恢复唯一可见主窗口。" },
  ],
  sideEffect: "reversible",
  tags: ["macos", "lifecycle"],
};

test("validates a Chinese CaseSpec against a multiline Swift @Test attribute", () => {
  const result = validateCaseSpecSources(
    [{ filePath: "window.case-spec.json", contents: JSON.stringify(validSpec) }],
    [{
      filePath: "WindowTests.swift",
      contents: `
        // @Test("Ignored comment")
        let example = "@Test(\"Ignored string\")"
        @Test(
          "${sourceName}",
          .disabled(if: false)
        )
        func roundtrip() {}
      `,
    }],
  );

  assert.equal(result.specCount, 1);
  assert.equal(result.swiftTestCount, 1);
  assert.equal(result.mappings[0]?.id, validSpec.id);
});

test("maps only the source set declared by each CaseSpec platform", () => {
  const windowsName = "Windows close can be restored";
  const crossPlatformName = "Settings opens and returns";
  const specs = [
    { filePath: "mac.case-spec.json", contents: JSON.stringify(validSpec) },
    {
      filePath: "windows.case-spec.json",
      contents: JSON.stringify({
        ...validSpec,
        id: "sample.lifecycle.windows-only",
        platforms: ["windows"],
        sourceName: windowsName,
      }),
    },
    {
      filePath: "shared.case-spec.json",
      contents: JSON.stringify({
        ...validSpec,
        id: "sample.settings.shared",
        platforms: ["macos", "windows"],
        sourceName: crossPlatformName,
      }),
    },
  ];
  const result = validateCaseSpecSources(
    specs,
    [{
      filePath: "MacTests.swift",
      contents: `
        @Test("${sourceName}") func macOnly() {}
        @Test("${crossPlatformName}") func shared() {}
      `,
    }],
    [{
      filePath: "WindowsTests.cs",
      contents: `
        [SurfaceLoomCase("${windowsName}")]
        public void WindowsOnly() {}

        [SurfaceLoomCase("${crossPlatformName}")]
        public void Shared() {}
      `,
    }],
  );

  assert.equal(result.specCount, 3);
  assert.equal(result.macosSpecCount, 2);
  assert.equal(result.windowsSpecCount, 2);
  assert.equal(result.swiftTestCount, 2);
  assert.equal(result.csharpTestCount, 2);
  assert.deepEqual(result.mappings.map((item) => item.sourceName), [sourceName, crossPlatformName]);
  assert.deepEqual(result.csharpMappings.map((item) => item.sourceName), [windowsName, crossPlatformName]);
});

test("scans only standalone static SurfaceLoomCase attributes", () => {
  assert.deepEqual(
    extractSampleCSharpCaseNames(`
      // [SurfaceLoomCase("Ignored comment")]
      var sample = "[SurfaceLoomCase(\\\"Ignored string\\\")]";
      [SurfaceLoomCase("Windows \\u0055I roundtrip", RequiresFactoryReset = true)]
      public void Roundtrip() {}
    `),
    ["Windows UI roundtrip"],
  );
  assert.throws(
    () => extractSampleCSharpCaseNames('[SurfaceLoomCase(nameof(Test))] void Test() {}'),
    /static single-line string/,
  );
  assert.throws(
    () => extractSampleCSharpCaseNames('[SurfaceLoomCase("A", "B")] void Test() {}'),
    /named attribute properties/,
  );
  assert.throws(
    () => extractSampleCSharpCaseNames('[SurfaceLoomCase("A" unexpected)] void Test() {}'),
    /SurfaceLoomCase must place a static source-name string.*\(1:1\)/,
  );
  assert.throws(
    () => extractSampleCSharpCaseNames('[SurfaceLoomCase("A"), Obsolete] void Test() {}'),
    /standalone attribute/,
  );
});

test("rejects missing or orphaned Windows source mappings", () => {
  const windowsSpec = {
    ...validSpec,
    platforms: ["windows"],
    sourceName: "Mapped Windows case",
  };
  assert.throws(
    () => validateCaseSpecSources(
      [{ filePath: "windows.case-spec.json", contents: JSON.stringify(windowsSpec) }],
      [],
      [{ filePath: "WindowsTests.cs", contents: '[SurfaceLoomCase("Orphaned Windows case")] void Test() {}' }],
    ),
    /no matching C# SurfaceLoomCase attribute|no matching CaseSpec sourceName/,
  );
});

test("rejects missing, duplicate, and implicit source-name mappings", () => {
  const sidecar = { filePath: "window.case-spec.json", contents: JSON.stringify(validSpec) };
  assert.throws(
    () => validateCaseSpecSources(
      [sidecar],
      [{ filePath: "WindowTests.swift", contents: '@Test("Different name") func different() {}' }],
    ),
    /no matching Swift @Test display name|no matching CaseSpec sourceName/,
  );
  assert.throws(
    () => validateCaseSpecSources(
      [
        sidecar,
        {
          filePath: "duplicate.case-spec.json",
          contents: JSON.stringify({ ...validSpec, id: "sample.lifecycle.duplicate" }),
        },
      ],
      [{ filePath: "WindowTests.swift", contents: `@Test("${sourceName}") func roundtrip() {}` }],
    ),
    /CaseSpec sourceName .* is duplicated/,
  );
  assert.throws(
    () => extractSwiftTestDisplayNames("@Test func implicitName() {}"),
    /static.*display[- ]name|display[- ]name.*static/i,
  );
  assert.throws(
    () => validateCaseSpecSources(
      [sidecar],
      [{
        filePath: "QualifiedTests.swift",
        contents: `
          @Test("${sourceName}") func mapped() {}
          @Testing.Test("Qualified test also requires a sidecar") func unmapped() {}
        `,
      }],
    ),
    /Qualified test also requires a sidecar.*no matching CaseSpec sourceName/,
  );
});

test("parses both supported CLI flag forms while preserving single-platform use", () => {
  assert.deepEqual(
    parseCaseSpecCliArguments([
      "--spec-dir=cases",
      "--swift-dir",
      "Tests",
      "--csharp-dir=WindowsTests",
      "--csharp-case-attribute",
      "SurfaceLoomCase",
    ]),
    {
      help: false,
      specDir: "cases",
      swiftDir: "Tests",
      csharpDir: "WindowsTests",
      csharpCaseAttribute: "SurfaceLoomCase",
    },
  );
  assert.deepEqual(
    parseCaseSpecCliArguments([
      "--spec-dir", "cases",
      "--swift-dir", "Tests",
    ]),
    {
      help: false,
      specDir: "cases",
      swiftDir: "Tests",
    },
  );
  assert.throws(
    () => parseCaseSpecCliArguments(["--spec-dir", "cases"]),
    /At least one native source directory is required/,
  );
  assert.throws(
    () => parseCaseSpecCliArguments([
      "--spec-dir", "cases",
      "--csharp-dir", "WindowsTests",
    ]),
    /--csharp-dir and --csharp-case-attribute must be provided together/,
  );
});
