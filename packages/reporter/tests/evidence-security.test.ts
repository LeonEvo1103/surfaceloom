import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { writeReportBundle } from "../src/index.js";
import { asPassing, createFixture, makeInput, pngEvidence } from "./support.js";

test("lossy test id segments cannot collide in evidence directories", async (context) => {
  const fixture = await createFixture(context);
  const leftSource = path.join(fixture, "left", "evidence.png");
  const rightSource = path.join(fixture, "right", "evidence.png");
  await Promise.all([mkdir(path.dirname(leftSource)), mkdir(path.dirname(rightSource))]);
  await Promise.all([writeFile(leftSource, pngEvidence()), writeFile(rightSource, pngEvidence())]);
  const base = makeInput({ screenshot: leftSource, video: "/missing.webm", trace: "/missing.jsonl" });
  const left = asPassing(base.tests[0]!);
  const rightArtifact = {
    ...left.result.artifacts![0]!,
    sourcePath: rightSource,
    id: "right-shot",
  };
  const output = path.join(fixture, "collision-report");
  const result = await writeReportBundle({
    ...base,
    tests: [
      {
        ...left,
        spec: { ...left.spec, id: "a:b" },
        result: { ...left.result, artifacts: [left.result.artifacts![0]!] },
      },
      {
        ...left,
        spec: { ...left.spec, id: "a-b", name: "第二个窗口用例" },
        result: { ...left.result, artifacts: [rightArtifact] },
      },
    ],
  }, output, { evidencePolicy: { screenshots: "always" } });
  const paths = result.report.tests.map((item) => item.result.artifacts[0]?.relativePath);
  assert.equal(new Set(paths).size, 2);
  for (const relativePath of paths) {
    assert.deepEqual(await readFile(path.join(output, relativePath!)), pngEvidence());
  }
});

test("sanitizes every human-authored report field", async (context) => {
  const fixture = await createFixture(context);
  const base = makeInput({
    screenshot: "/missing/screenshot.png",
    video: "/missing/video.webm",
    trace: "/missing/events.jsonl",
  });
  const secret = "token=private-value /Users/alice/private.txt";
  const first = base.tests[0]!;
  const { sourcePath: _sourcePath, ...artifactWithoutSource } = first.result.artifacts![0]!;
  const result = await writeReportBundle({
    run: {
      ...base.run,
      title: `Run ${secret}`,
      app: { ...base.run.app, name: `App ${secret}`, version: secret },
      environment: { runnerName: secret, branch: secret },
    },
    tests: [
      {
        ...first,
        spec: {
          ...first.spec,
          suite: { ...first.spec.suite, name: `报告安全 ${secret}` },
          name: `中文用例 ${secret}`,
          sourceName: secret,
          intent: `验证报告文本会脱敏 ${secret}`,
          preconditions: [{ id: "safe-input", text: `输入来自测试夹具 ${secret}` }],
          acceptanceCriteria: [{ id: "redacted", text: `敏感文本不会落盘 ${secret}` }],
          tags: [secret],
        },
        result: {
          ...first.result,
          steps: [{
            ...first.result.steps[0]!,
            title: secret,
            componentId: secret,
            action: secret,
            assertion: secret,
            diagnostic: secret,
            criterionIds: ["redacted"],
          }],
          artifacts: [{
            ...artifactWithoutSource,
            captureStatus: "captureFailed",
            title: secret,
            description: secret,
            captureError: secret,
          }],
        },
      },
      {
        ...base.tests[1]!,
        result: {
          ...base.tests[1]!.result,
          reason: `当前环境不满足门禁 ${secret}`,
        },
      },
    ],
  }, path.join(fixture, "redacted"));
  const serialized = JSON.stringify(result.report);
  assert.doesNotMatch(serialized, /private-value|\/Users\/alice/);
  assert.match(serialized, /token=\[REDACTED\]|\$USER_HOME/);
});

test("uses safe extensions for non-preview attachments", async (context) => {
  const fixture = await createFixture(context);
  const payload = path.join(fixture, "payload.html");
  await writeFile(payload, "<script>globalThis.compromised=true</script>");
  const base = makeInput({
    screenshot: "/missing/screenshot.png",
    video: "/missing/video.webm",
    trace: "/missing/events.jsonl",
  });
  const first = base.tests[0]!;
  const result = await writeReportBundle({
    ...base,
    tests: [{
      ...first,
      result: {
        ...first.result,
        artifacts: [{
          ...first.result.artifacts![0]!,
          id: "diagnostics",
          kind: "diagnostics",
          contentType: "text/plain",
          sourcePath: payload,
        }],
      },
    }],
  }, path.join(fixture, "safe-extension"));
  const artifact = result.report.tests[0]!.result.artifacts[0]!;
  assert.match(artifact.relativePath ?? "", /\.txt$/);
  assert.match(await readFile(result.htmlPath, "utf8"), /download/);
});

test("rejects media whose bytes do not match its declared type", async (context) => {
  const fixture = await createFixture(context);
  const disguised = path.join(fixture, "disguised.png");
  await writeFile(disguised, "<script>not an image</script>");
  const base = makeInput({ screenshot: disguised, video: "/missing.webm", trace: "/missing.jsonl" });
  const first = base.tests[0]!;
  const result = await writeReportBundle({
    ...base,
    tests: [{
      ...first,
      result: { ...first.result, artifacts: [first.result.artifacts![0]!] },
    }],
  }, path.join(fixture, "mismatch"));
  const artifact = result.report.tests[0]!.result.artifacts[0]!;
  assert.equal(artifact.captureStatus, "captureFailed");
  assert.match(artifact.captureError ?? "", /CONTENT_TYPE_MISMATCH/);
  const entries = await readdir(path.join(result.directory, "evidence"), {
    recursive: true,
    withFileTypes: true,
  });
  assert.deepEqual(entries.filter((entry) => entry.isFile()), []);
});

test("source basenames never enter report paths", async (context) => {
  const fixture = await createFixture(context);
  const source = path.join(fixture, "private-SOURCEFILENAMESECRET123.png");
  await writeFile(source, pngEvidence());
  const base = makeInput({ screenshot: source, video: "/missing.webm", trace: "/missing.jsonl" });
  const first = base.tests[0]!;
  const result = await writeReportBundle({
    ...base,
    tests: [{
      ...first,
      result: { ...first.result, artifacts: [first.result.artifacts![0]!] },
    }],
  }, path.join(fixture, "safe-basename"));
  const serialized = JSON.stringify(result.report);
  assert.doesNotMatch(serialized, /SOURCEFILENAMESECRET/);
  assert.match(result.report.tests[0]!.result.artifacts[0]!.relativePath ?? "", /01-failure-screenshot\.png$/);
});

test("symbolic-link evidence sources are rejected", async (context) => {
  if (process.platform === "win32") return;
  const fixture = await createFixture(context);
  const target = path.join(fixture, "target.png");
  const link = path.join(fixture, "link.png");
  await writeFile(target, pngEvidence());
  await symlink(target, link);
  const base = makeInput({ screenshot: link, video: "/missing.webm", trace: "/missing.jsonl" });
  const first = base.tests[0]!;
  const result = await writeReportBundle({
    ...base,
    tests: [{
      ...first,
      result: { ...first.result, artifacts: [first.result.artifacts![0]!] },
    }],
  }, path.join(fixture, "symlink"));
  const artifact = result.report.tests[0]!.result.artifacts[0]!;
  assert.equal(artifact.captureStatus, "captureFailed");
  assert.equal(artifact.relativePath, undefined);
});
