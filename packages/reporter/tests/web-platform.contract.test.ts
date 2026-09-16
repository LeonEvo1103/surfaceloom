import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  type CaseReportInput,
  normalizeReportInput,
  type ReportBundleInput,
  validateReportInput,
  writeReportBundle,
} from "../src/index.js";
import { stubTest } from "./report-contract-fixtures.js";
import { createFixture } from "./support.js";

function webRun(tests: ReportBundleInput["tests"]): ReportBundleInput {
  return {
    run: {
      id: "run-web",
      title: "Web 运行",
      platform: "web",
      startedAt: "2026-08-19T01:00:00.000Z",
      finishedAt: "2026-08-19T01:00:01.000Z",
      app: { id: "fixture.web", name: "Fixture Web" },
    },
    tests,
  };
}

test("accepts a web run and keeps web a platform of its own", async (context) => {
  const fixture = await createFixture(context);
  const testCase = stubTest("passed");
  const input = webRun([
    { ...testCase, spec: { ...testCase.spec, platforms: ["web"] } },
  ]);

  const normalized = normalizeReportInput(input);
  assert.deepEqual(normalized.tests[0]?.spec.platforms, ["web"]);

  const bundle = await writeReportBundle(input, path.join(fixture, "web-report"));
  const persisted = JSON.parse(
    await readFile(bundle.reportPath, "utf8"),
  ) as { run: { platform: string } };
  assert.equal(persisted.run.platform, "web");

  const markdown = await readFile(bundle.aiReviewPath, "utf8");
  assert.match(markdown, /平台：Web/u);
  assert.equal(markdown.includes("macOS"), false);
  assert.equal(markdown.includes("Windows"), false);

  const page = await readFile(bundle.htmlPath, "utf8");
  assert.match(page, /<span>Web<\/span>/u);
});

test("normalizes a legacy web case to the web run platform", () => {
  const testCase = stubTest("passed");
  const { platforms: _platforms, ...legacySpec } = testCase.spec;
  const normalized = normalizeReportInput(
    webRun([{ ...testCase, spec: legacySpec } as CaseReportInput]),
  );
  assert.deepEqual(normalized.tests[0]?.spec.platforms, ["web"]);
});

test("rejects a desktop-only case inside a web run", () => {
  const testCase = stubTest("passed");
  assert.throws(
    () => validateReportInput(
      webRun([{ ...testCase, spec: { ...testCase.spec, platforms: ["macos"] } }]),
    ),
    /does not support run platform web/,
  );
});

test("rejects an unknown run platform by name", () => {
  const testCase = stubTest("passed");
  assert.throws(
    () => validateReportInput({
      ...webRun([testCase]),
      run: { ...webRun([testCase]).run, platform: "linux" as never },
    }),
    /Unknown test platform\./,
  );
});
