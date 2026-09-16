import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  type CaseReportInput,
  type NormalizedCaseReportInput,
  normalizeReportInput,
  type ReportBundleInput,
  sanitizeTestCase,
  validateReportInput,
  writeReportBundle,
} from "../src/index.js";
import { stubTest } from "./report-contract-fixtures.js";
import { createFixture } from "./support.js";

test("accepts legacy v2 cases and emits their conservative platform normalization", async (context) => {
  const fixture = await createFixture(context);
  const current = stubTest("passed");
  const { platforms: _platforms, ...legacySpec } = current.spec;
  const legacyInput: ReportBundleInput = {
    run: {
      id: "run-legacy-v2",
      title: "Legacy v2",
      platform: "windows",
      startedAt: "2026-08-19T01:00:00.000Z",
      finishedAt: "2026-08-19T01:00:01.000Z",
      app: { id: "fixture", name: "Fixture" },
    },
    tests: [{ ...current, spec: legacySpec }],
  };

  const normalized = normalizeReportInput(legacyInput);
  assert.deepEqual(normalized.tests[0]?.spec.platforms, ["windows"]);
  assert.equal(Object.hasOwn(legacySpec, "platforms"), false);

  const result = await writeReportBundle(legacyInput, path.join(fixture, "legacy-report"));
  const persisted = JSON.parse(await readFile(result.reportPath, "utf8")) as {
    schemaVersion: string;
    tests: Array<{ spec: { platforms?: string[] } }>;
  };
  assert.equal(persisted.schemaVersion, "surfaceloom.report/v2");
  assert.deepEqual(persisted.tests[0]?.spec.platforms, ["windows"]);
});

test("public sanitizer preserves legacy shape and normalized overload precision", () => {
  const normalizedInput = stubTest("passed");
  const normalized: NormalizedCaseReportInput = sanitizeTestCase(normalizedInput);
  assert.deepEqual(normalized.spec.platforms, ["macos", "windows"]);

  const { platforms: _platforms, ...legacySpec } = normalizedInput.spec;
  const legacyInput: CaseReportInput = { ...normalizedInput, spec: legacySpec };
  const legacy: CaseReportInput = sanitizeTestCase(legacyInput);
  assert.equal(Object.hasOwn(legacy.spec, "platforms"), false);
  assert.equal(Object.isFrozen(legacy), true);
  assert.equal(Object.isFrozen(legacy.spec), true);
});

test("rejects a case whose declared platforms exclude the run platform", () => {
  const testCase = stubTest("passed");
  assert.throws(
    () => validateReportInput({
      run: {
        id: "run-platform-mismatch",
        title: "Platform mismatch",
        platform: "windows",
        startedAt: "2026-08-19T01:00:00.000Z",
        finishedAt: "2026-08-19T01:00:01.000Z",
        app: { id: "fixture", name: "Fixture" },
      },
      tests: [{ ...testCase, spec: { ...testCase.spec, platforms: ["macos"] } }],
    }),
    /does not support run platform windows/,
  );
});

test("rejects internally contradictory green results", () => {
  const input = {
    run: {
      id: "run",
      title: "Run",
      platform: "macos" as const,
      startedAt: "2026-08-19T01:00:00.000Z",
      finishedAt: "2026-08-19T01:00:01.000Z",
      app: { id: "fixture", name: "Fixture" },
    },
    tests: [{
      ...stubTest("passed"),
      result: {
        ...stubTest("passed").result,
        steps: [{
          id: "assert",
          title: "执行断言",
          status: "failed" as const,
          durationMs: 1,
          criterionIds: ["result-explicit"],
        }],
      },
    }],
  };
  assert.throws(() => validateReportInput(input), /passed but contains a non-passing step/);
  assert.throws(
    () => validateReportInput({
      ...input,
      tests: [{
        ...stubTest("passed"),
        result: {
          ...stubTest("passed").result,
          error: { category: "assertion", message: "unexpected" },
        },
      }],
    }),
    /must not include an error/,
  );
});

test("rejects paths and credential assignments in stable ids", () => {
  const input = {
    run: {
      id: "/Users/alice/report",
      title: "Run",
      platform: "macos" as const,
      startedAt: "2026-08-19T01:00:00.000Z",
      finishedAt: "2026-08-19T01:00:01.000Z",
      app: { id: "fixture", name: "Fixture" },
    },
    tests: [stubTest("passed")],
  };
  assert.throws(() => validateReportInput(input), /machine-id character set/);
  assert.throws(
    () => validateReportInput({
      ...input,
      run: { ...input.run, id: "run" },
      tests: [{
        ...stubTest("passed"),
        spec: { ...stubTest("passed").spec, id: "token=secret" },
      }],
    }),
    /machine-id character set/,
  );
});

test("rejects implementation-specific non-ISO timestamps", () => {
  const input = {
    run: {
      id: "run",
      title: "Run",
      platform: "macos" as const,
      startedAt: "08/19/2026 01:00:00",
      finishedAt: "2026-08-19T01:00:01.000Z",
      app: { id: "fixture", name: "Fixture" },
    },
    tests: [stubTest("passed")],
  };
  assert.throws(() => validateReportInput(input), /must be an ISO timestamp/);
  assert.throws(
    () => validateReportInput({
      ...input,
      run: {
        ...input.run,
        startedAt: "2026-02-30T01:00:00.000Z",
        finishedAt: "2026-03-01T01:00:00.000Z",
      },
    }),
    /must be a valid ISO timestamp/,
  );
});

test("rejects unknown fields and malformed optional primitive values", () => {
  const base = {
    run: {
      id: "run",
      title: "Run",
      platform: "macos" as const,
      startedAt: "2026-08-19T01:00:00.000Z",
      finishedAt: "2026-08-19T01:00:01.000Z",
      app: { id: "fixture", name: "Fixture" },
    },
    tests: [stubTest("passed")],
  };
  assert.throws(
    () => validateReportInput({
      ...base,
      run: { ...base.run, app: { ...base.run.app, apiKey: "sk-extra-field-secret" } },
    } as never),
    /contains an unknown field/,
  );
  assert.throws(
    () => validateReportInput({
      ...base,
      run: { ...base.run, environment: { ci: { token: "secret" } } },
    } as never),
    /run\.environment\.ci must be a boolean/,
  );
  assert.throws(
    () => validateReportInput({
      ...base,
      tests: [{ ...stubTest("passed"), password: "secret" }],
    } as never),
    /contains an unknown field/,
  );
  assert.throws(
    () => validateReportInput({
      ...base,
      run: { ...base.run, id: "sk-IDENTIFIERSECRET123" },
    }),
    /must not contain credential-like data/,
  );
  assert.throws(
    () => validateReportInput({
      ...base,
      tests: [{
        ...stubTest("passed"),
        spec: { ...stubTest("passed").spec, tags: new Array(1) },
      }],
    } as never),
    /tags must contain only strings/,
  );
});
