import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SourceArtifact } from "../../src/model.js";
import {
  RequiredArtifactPublicationError,
  type WriteReportV3Options,
  writeReportV3Bundle,
} from "../../src/index.js";
import { v3Input } from "./fixtures.js";

const requirement = Object.freeze({ caseId: "case-v3", attemptId: "attempt-2",
  artifactId: "required-log", expectedSizeBytes: Buffer.byteLength("original"),
  expectedSha256: createHash("sha256").update("original").digest("hex") });

test("required artifact failures abort the real bundle before a completion marker", async (context) => {
  const root = await temporary(context);
  const scenarios: Array<{ name: string; artifact?: SourceArtifact; evidencePolicy?: { logs: "off" };
    code: string }> = [
    { name: "missing", code: "missing" },
    { name: "capture-failed", artifact: artifact({ captureStatus: "captureFailed" }),
      code: "captureFailed" },
    { name: "retained-out", artifact: artifact({ captureStatus: "captured",
      sourcePath: path.join(root, "retained.txt") }), evidencePolicy: { logs: "off" },
      code: "retainedOut" },
    { name: "copy-failed", artifact: artifact({ captureStatus: "captured",
      sourcePath: path.join(root, "does-not-exist.txt") }), code: "captureFailed" },
  ];
  await writeFile(path.join(root, "retained.txt"), "retained");
  for (const scenario of scenarios) {
    const input = v3Input();
    if (scenario.artifact !== undefined) attach(input, scenario.artifact);
    const output = path.join(root, scenario.name);
    await assert.rejects(
      writeReportV3Bundle(input, output, {
        requiredArtifacts: [requirement],
        ...(scenario.evidencePolicy === undefined ? {} : { evidencePolicy: scenario.evidencePolicy }),
      }),
      (error: unknown) => error instanceof RequiredArtifactPublicationError
        && error.failures[0]?.code === scenario.code,
    );
    await assert.rejects(stat(path.join(output, "complete.json")), { code: "ENOENT" });
    await assert.rejects(stat(output), { code: "ENOENT" });
  }
});

test("required publication rejects a substituted copy and leaves no completion marker", async (context) => {
  const root = await temporary(context);
  const source = path.join(root, "source.txt");
  await writeFile(source, "substituted-after-runner-receipt");
  const input = v3Input();
  attach(input, artifact({ captureStatus: "captured", sourcePath: source }));
  const output = path.join(root, "report");
  await assert.rejects(
    writeReportV3Bundle(input, output, { requiredArtifacts: [requirement] }),
    (error: unknown) => error instanceof RequiredArtifactPublicationError
      && error.failures[0]?.code === "copyChanged",
  );
  await assert.rejects(stat(path.join(output, "complete.json")), { code: "ENOENT" });
  await assert.rejects(stat(output), { code: "ENOENT" });
});

test("Reporter options and required refs are copied descriptor-only without executing hostile hooks",
  async (context) => {
    const root = await temporary(context);
    let calls = 0;
    const valid = { ...requirement };
    const getterOptions = Object.defineProperty({}, "requiredArtifacts", { enumerable: true,
      get: () => { calls += 1; return [valid]; } });
    const proxyOptions = new Proxy({}, { ownKeys: () => { calls += 1; return []; } });
    const proxyArray = new Proxy([valid], { ownKeys: () => { calls += 1; return []; } });
    const proxyEntry = new Proxy(valid, { ownKeys: () => { calls += 1; return []; } });
    const proxyPolicy = new Proxy({}, { ownKeys: () => { calls += 1; return []; } });
    const accessorEntry = Object.defineProperty({ ...valid }, "artifactId", { enumerable: true,
      get: () => { calls += 1; return "required-log"; } });
    const replacedMap = [valid] as typeof valid[] & { map: () => never };
    replacedMap.map = () => { calls += 1; throw new Error("must not call map"); };
    const replacedIterator = [valid] as typeof valid[] & { [Symbol.iterator]: () => never };
    replacedIterator[Symbol.iterator] = () => { calls += 1; throw new Error("must not iterate"); };
    const toJSONEntry = { ...valid, toJSON: () => { calls += 1; return {}; } };
    const holes = new Array(1) as unknown[];
    const cases: unknown[] = [getterOptions, proxyOptions, { requiredArtifacts: proxyArray },
      { requiredArtifacts: [proxyEntry] }, { evidencePolicy: proxyPolicy },
      { requiredArtifacts: [accessorEntry] }, { requiredArtifacts: replacedMap },
      { requiredArtifacts: replacedIterator }, { requiredArtifacts: [toJSONEntry] },
      { requiredArtifacts: holes }];
    for (const [index, hostile] of cases.entries()) {
      await assert.rejects(writeReportV3Bundle(v3Input(), path.join(root, `hostile-${index}`),
        hostile as WriteReportV3Options));
    }
    assert.equal(calls, 0);
  });

function artifact(input: Pick<SourceArtifact, "captureStatus"> &
  Partial<Pick<SourceArtifact, "sourcePath">>): SourceArtifact {
  return { id: requirement.artifactId, kind: "log", phase: "after", title: "Required log",
    contentType: "text/plain", capturedAt: "2026-09-16T01:00:00.000Z", ...input,
    ...(input.captureStatus === "captureFailed" ? { captureError: "synthetic capture failure" } : {}) };
}

function attach(input: ReturnType<typeof v3Input>, value: SourceArtifact): void {
  const attempts = input.tests[0]!.attempts;
  if (attempts.state !== "known") throw new Error("Expected known attempts.");
  const attempt = attempts.items.find((item) => item.id === requirement.attemptId)!;
  (attempt.result as { artifacts?: readonly SourceArtifact[] }).artifacts = [value];
}

async function temporary(context: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "p3-055-required-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
