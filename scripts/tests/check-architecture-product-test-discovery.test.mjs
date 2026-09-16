import assert from "node:assert/strict";
import test from "node:test";

import { withArchitectureFixture } from "./support/architecture-fixture.mjs";

const productPath = (...segments) => `${["pro", "jects"].join("")}/${segments.join("/")}`;

test("architecture guard scans product tests outside a Scenarios directory", async () => {
  await withArchitectureFixture(
    {
      [productPath("sample", "Tests", "RawScenario.swift")]:
        "let element: AXUIElement\n",
    },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stdout, /RawScenario\.swift/);
      assert.match(result.stderr, /scenario tests must use components/);
    },
  );
});

test("architecture guard rejects direct Windows host protocol access", async () => {
  await withArchitectureFixture(
    {
      [productPath("sample", "windows", "Tests", "RawScenario.cs")]:
        "using SurfaceLoom.WindowsHost.Host; var dispatcher = new RequestDispatcher();\n",
    },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stdout, /RawScenario\.cs/);
    },
  );
});

test("architecture guard rejects PascalCase facade escape hatches", async () => {
  await withArchitectureFixture(
    {
      [productPath("sample", "windows", "Tests", "RawScenario.cs")]:
        "app.Session.PerformRawAction();\n",
    },
    (result) => {
      assert.equal(result.status, 2);
      assert.match(result.stdout, /RawScenario\.cs/);
    },
  );
});
