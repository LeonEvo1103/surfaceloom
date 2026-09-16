import assert from "node:assert/strict";
import test from "node:test";

import { withArchitectureFixture } from "./support/architecture-fixture.mjs";

const withFixture = withArchitectureFixture;
const productPath = (...segments) => `${["pro", "jects"].join("")}/${segments.join("/")}`;

test("architecture guard discovers semantic Scenarios and product Windows Tests only", async () => {
  await withFixture(
    {
      [productPath("sample", "Scenarios", "Clean.swift")]: "semanticComponent.perform()\n",
      [productPath("sample", "windows", "Tests", "Clean.cs")]: "SemanticComponent.Perform();\n",
      [productPath("sample", "windows", "Tests", "Support", "RawHelper.cs")]: "AutomationElement helper;\n",
      [productPath("sample", "windows", "Tests", "Adapter", "RawAdapter.cs")]: "ControlType adapter;\n",
      [productPath("sample", "windows", "Tests", "Contracts", "RawContract.cs")]: "UiaSession contract;\n",
    },
    (result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Architecture check passed/);
    },
  );
});

test("architecture guard rejects raw APIs in a product Windows test", async () => {
  await withFixture(
    { [productPath("sample", "windows", "Tests", "RawScenario.cs")]: "WindowsHostSession session;\n" },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stdout, /RawScenario\.cs/);
      assert.match(result.stderr, /scenario tests must use components/);
    },
  );
});

test("architecture guard rejects raw APIs in a Scenarios directory", async () => {
  await withFixture(
    { [productPath("sample", "Tests", "Scenarios", "RawScenario.swift")]: "let element: AXUIElement\n" },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stdout, /RawScenario\.swift/);
    },
  );
});

test("architecture guard rejects platform driver objects in a scenario", async () => {
  await withFixture(
    { [productPath("sample", "Tests", "Scenarios", "RawDriver.swift")]: "let driver: MacOSApplicationDriver\n" },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stdout, /RawDriver\.swift/);
      assert.match(result.stderr, /scenario tests must use components/);
    },
  );
});

test("architecture guard rejects direct backend imports in a scenario", async () => {
  await withFixture(
    {
      [productPath("sample", "Tests", "Scenarios", "BackendImport.swift")]:
        "import SurfaceLoomMacOS\n",
    },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stdout, /BackendImport\.swift/);
    },
  );
});

test("architecture guard rejects facade escape hatches in a scenario", async () => {
  await withFixture(
    {
      [productPath("sample", "Tests", "Scenarios", "FacadeEscape.swift")]:
        "app.session.driver.press(element)\n",
    },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stdout, /FacadeEscape\.swift/);
    },
  );
});

test("architecture guard rejects shared references to product paths", async () => {
  await withFixture(
    { "packages/reporter/tests/reverse.test.ts": `read("${productPath("sample", "contracts")}")\n` },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stderr, /must not reference product project paths/);
    },
  );
});

test("architecture guard rejects product dependencies in shared package manifests", async () => {
  await withFixture(
    {
      [productPath("sample", "README.md")]: "product marker\n",
      "packages/core/package.json": JSON.stringify({
        dependencies: { adapter: `file:../../${productPath("sample")}` },
      }),
    },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stdout, /package\.json/);
      assert.match(result.stderr, /must not reference product project paths/);
    },
  );
});

test("architecture guard rejects product references in the shared Swift manifest", async () => {
  await withFixture(
    {
      [productPath("sampleproduct", "README.md")]: "product marker\n",
      "Package.swift": "let productAdapter = \"sampleproduct\"\n",
    },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stdout, /Package\.swift/);
      assert.match(result.stderr, /must not contain product name 'sampleproduct'/);
    },
    "grep",
  );
});

test("architecture guard rejects product references in shared templates", async () => {
  await withFixture(
    {
      [productPath("sampleproduct", "README.md")]: "product marker\n",
      "Templates/ScenarioTests.swift.template": "struct SampleProductScenario {}\n",
    },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stdout, /ScenarioTests\.swift\.template/);
      assert.match(result.stderr, /must not contain product name 'sampleproduct'/);
    },
  );
});

test("architecture guard keeps shared script libraries product-neutral", async () => {
  await withFixture(
    { "scripts/product-loader.mjs": `read("${productPath("sample", "contracts")}")\n` },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stderr, /must not reference product project paths/);
    },
  );
});

test("architecture guard also scans shared script tests", async () => {
  await withFixture(
    { "scripts/tests/reverse.test.mjs": `read("${productPath("sample", "contracts")}")\n` },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stderr, /must not reference product project paths/);
    },
  );
});

test("architecture guard rejects product names in shared backend sources", async () => {
  await withFixture(
    {
      [productPath("sampleproduct", "README.md")]: "product marker\n",
      "native/windows-host/src/ProductShortcut.cs": "class SampleProductShortcut {}\n",
    },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stderr, /must not contain product name 'sampleproduct'/);
    },
  );
});

test("architecture guard rejects product names in shared source paths", async () => {
  await withFixture(
    {
      [productPath("sampleproduct", "README.md")]: "product marker\n",
      "native/windows-host/tests/SampleProductContractTests.cs": "class ContractTests {}\n",
    },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stdout, /SampleProductContractTests\.cs/);
      assert.match(result.stderr, /must not contain product name 'sampleproduct'/);
    },
  );
});

test("architecture guard does not treat the repository parent path as a shared product reference", async () => {
  await withFixture(
    {
      [productPath("surfaceloom-architecture", "README.md")]: "product marker\n",
      "packages/core/src/NeutralContract.ts": "export const neutral = true;\n",
    },
    (result) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Architecture check passed/);
    },
  );
});

test("architecture guard uses the grep fallback for Windows scenario discovery", async () => {
  await withFixture(
    { [productPath("sample", "windows", "Tests", "RawScenario.cs")]: "UiaSession session;\n" },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stdout, /RawScenario\.cs/);
      assert.match(result.stderr, /scenario tests must use components/);
    },
    "grep",
  );
});

test("short product names do not match ordinary shared words", async () => {
  await withFixture(
    {
      [productPath("app", "README.md")]: "product marker\n",
      "packages/core/src/application.ts": "export const application = true;\n",
    },
    (result) => {
      assert.equal(result.status, 0, result.stderr);
    },
  );
});

test("short product names still reject exact shared identities", async () => {
  await withFixture(
    {
      [productPath("app", "README.md")]: "product marker\n",
      "packages/core/src/product.ts": 'export const product = "app";\n',
    },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stderr, /must not contain product name 'app'/);
    },
  );
});

test("hyphenated product names reject compact shared symbols", async () => {
  await withFixture(
    {
      [productPath("sample-app", "README.md")]: "product marker\n",
      "native/windows-host/src/ProductAdapter.cs": "class SampleAppAdapter {}\n",
    },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stderr, /must not contain product name 'sample-app'/);
    },
  );
});
