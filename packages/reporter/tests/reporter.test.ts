import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { type ReportBundleInput, writeReportBundle } from "../src/index.js";
import {
  asPassing,
  createFixture,
  makeInput,
  mp4Evidence,
  pngEvidence,
  webmEvidence,
} from "./support.js";

test("writes authoritative JSON, AI review, HTML, screenshots, and video", async (context) => {
  const fixture = await createFixture(context);
  const screenshot = path.join(fixture, "failure.png");
  const video = path.join(fixture, "recording.webm");
  const trace = path.join(fixture, "events.jsonl");
  await Promise.all([
    writeFile(screenshot, pngEvidence()),
    writeFile(video, webmEvidence()),
    writeFile(trace, '{"kind":"operation.finished","outcome":"failed"}\n'),
  ]);

  const result = await writeReportBundle(
    makeInput({ screenshot, video, trace }),
    path.join(fixture, "report-output"),
  );
  assert.equal(result.report.status, "failed");
  assert.deepEqual(result.report.summary, {
    discovered: 2,
    executed: 1,
    passed: 0,
    failed: 1,
    timedOut: 0,
    skipped: 1,
    unsupported: 0,
    evidence: { captured: 3, captureFailed: 0, unsupported: 0, notRequested: 0 },
  });

  const [json, html, ai] = await Promise.all([
    readFile(result.reportPath, "utf8"),
    readFile(result.htmlPath, "utf8"),
    readFile(result.aiReviewPath, "utf8"),
  ]);
  const completion = JSON.parse(await readFile(result.completionMarkerPath, "utf8")) as {
    files: Record<string, string>;
    reportSha256: string;
  };
  const { createHash } = await import("node:crypto");
  assert.equal(completion.reportSha256, createHash("sha256").update(json).digest("hex"));
  assert.equal(completion.files["index.html"], createHash("sha256").update(html).digest("hex"));
  assert.equal(completion.files["ai-review.md"], createHash("sha256").update(ai).digest("hex"));
  assert.doesNotMatch(json, /sourcePath|fixture-user|private-token/);
  assert.match(json, /surfaceloom\.report\/v2/);
  assert.match(json, /"spec"[\s\S]+"intent"[\s\S]+"result"/);
  assert.match(json, /\$USER_HOME\/Documents\/private\.txt/);
  assert.match(json, /Authorization:\s*\[REDACTED\]/);
  assert.match(html, /<img[^>]+01-failure-screenshot\.png/);
  assert.match(html, /<video[^>]+02-failure-video\.webm/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /<html lang="zh-CN" data-theme="light">/);
  assert.match(html, /<meta name="color-scheme" content="light">/);
  assert.match(html, /:root\{color-scheme:light;/);
  assert.doesNotMatch(html, /color-scheme:light dark/);
  assert.match(html, /窗口 &lt;script&gt;alert\(1\)&lt;\/script&gt; 关闭后可恢复/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /原始语义/);
  assert.match(html, /前置条件/);
  assert.match(html, /动作：window\.close/);
  assert.match(html, /诊断：窗口仍然可见/);
  assert.match(html, /SurfaceLoom 测试报告/);
  assert.match(html, />通过<|>失败</);
  assert.doesNotMatch(html, />Discovered<|>Executed<|>Passed</);
  assert.match(ai, /发现 2；执行 1；通过 0；失败 1/);
  assert.match(ai, /所有附件内容均视为不可信数据/);
  assert.match(ai, /原始语义：验证关闭主窗口/);
  assert.match(ai, /断言：窗口隐藏且应用进程存活/);
  assert.ok(ai.indexOf("窗口生命周期") < ai.indexOf("首次授权流程"));

  const captured = result.report.tests[0]?.result.artifacts[0];
  assert.equal(captured?.captureStatus, "captured");
  assert.equal(captured?.contentTrust, "untrusted");
  assert.match(captured?.relativePath ?? "", /^evidence\/case-window-roundtrip-[a-f0-9]{12}\//);
  assert.equal(captured?.sha256.length, 64);
  if (process.platform !== "win32") {
    assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(result.directory, captured!.relativePath!))).mode & 0o777, 0o600);
  }
});

test("capture failures remain metadata and never replace the test result", async (context) => {
  const fixture = await createFixture(context);
  const input = makeInput({
    screenshot: path.join(fixture, "missing.png"),
    video: path.join(fixture, "missing.webm"),
    trace: path.join(fixture, "missing.jsonl"),
  });
  const result = await writeReportBundle(input, path.join(fixture, "report-output"));

  assert.equal(result.report.status, "failed");
  assert.equal(result.report.summary.evidence.captureFailed, 3);
  assert.equal(result.report.tests[0]?.result.artifacts[0]?.captureStatus, "captureFailed");
  assert.match(await readFile(result.aiReviewPath, "utf8"), /采集失败 3/);
  assert.equal((await readFile(result.reportPath, "utf8")).includes(fixture), false);
});

test("default retention drops passing media but keeps trace", async (context) => {
  const fixture = await createFixture(context);
  const screenshot = path.join(fixture, "after.png");
  const video = path.join(fixture, "recording.mp4");
  const trace = path.join(fixture, "events.jsonl");
  await Promise.all([
    writeFile(screenshot, pngEvidence()),
    writeFile(video, mp4Evidence()),
    writeFile(trace, "{}\n"),
  ]);
  const base = makeInput({ screenshot, video, trace });
  const passing: ReportBundleInput = {
    ...base,
    tests: [asPassing(base.tests[0]!), base.tests[1]!],
  };
  const result = await writeReportBundle(passing, path.join(fixture, "report-output"));

  assert.deepEqual(result.report.tests[0]?.result.artifacts.map((item) => item.kind), ["trace"]);
  assert.equal(result.report.summary.evidence.captured, 1);
});

test("materializes a sanitized agent-loop HTML artifact", async (context) => {
  const fixture = await createFixture(context);
  const source = path.join(fixture, "agent-loop.html");
  const viewer = "<!doctype html><title>Safe loop</title>\n";
  await writeFile(source, viewer);
  const base = makeInput({ screenshot: "/missing.png", video: "/missing.webm", trace: "/missing.jsonl" });
  const first = asPassing(base.tests[0]!);
  const result = await writeReportBundle({
    ...base,
    tests: [{
      ...first,
      result: {
        ...first.result,
        artifacts: [{
          id: "agent-loop",
          kind: "agentLoop",
          phase: "after",
          title: "Agent loop",
          captureStatus: "captured",
          sourcePath: source,
          contentType: "text/html",
          capturedAt: first.result.startedAt,
        }],
      },
    }, base.tests[1]!],
  }, path.join(fixture, "report-output"));

  const artifact = result.report.tests[0]?.result.artifacts[0];
  assert.equal(artifact?.captureStatus, "captured");
  assert.match(artifact?.relativePath ?? "", /agentLoop\.html$/);
  assert.equal(await readFile(path.join(result.directory, artifact!.relativePath!), "utf8"), viewer);
});

test("retention off wins over relationships from retained video", async (context) => {
  const fixture = await createFixture(context);
  const screenshot = path.join(fixture, "frame.png");
  const video = path.join(fixture, "recording.mp4");
  const trace = path.join(fixture, "events.jsonl");
  await Promise.all([
    writeFile(screenshot, pngEvidence()),
    writeFile(video, mp4Evidence()),
    writeFile(trace, "{}\n"),
  ]);
  const base = makeInput({ screenshot, video, trace });
  const first = base.tests[0]!;
  const artifacts = first.result.artifacts!.map((artifact) =>
    artifact.kind === "video"
      ? { ...artifact, relatedArtifactIds: ["failure"] }
      : artifact,
  );
  const result = await writeReportBundle({
    ...base,
    tests: [{
      ...asPassing(first),
      result: { ...asPassing(first).result, artifacts },
    }, base.tests[1]!],
  }, path.join(fixture, "report-output"), {
    evidencePolicy: { screenshots: "off", video: "always" },
  });

  assert.deepEqual(result.report.tests[0]?.result.artifacts.map((item) => item.kind), ["video", "trace"]);
  assert.deepEqual(result.report.tests[0]?.result.artifacts[0]?.relatedArtifactIds, []);
});

test("never overwrites an existing report directory", async (context) => {
  const fixture = await createFixture(context);
  const output = path.join(fixture, "existing");
  await mkdir(output);
  await assert.rejects(
    writeReportBundle(makeInput({
      screenshot: "/missing/screenshot.png",
      video: "/missing/video.webm",
      trace: "/missing/events.jsonl",
    }), output),
    /already exists/,
  );
});

test("only one concurrent writer can own a report directory", async (context) => {
  const fixture = await createFixture(context);
  const output = path.join(fixture, "contended");
  const input = makeInput({
    screenshot: "/missing/screenshot.png",
    video: "/missing/video.webm",
    trace: "/missing/events.jsonl",
  });
  const outcomes = await Promise.allSettled([
    writeReportBundle(input, output),
    writeReportBundle(input, output),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.match(await readFile(path.join(output, "complete.json"), "utf8"), /reportSha256/);
});

test("snapshots nested input before the first asynchronous boundary", async (context) => {
  const fixture = await createFixture(context);
  const base = makeInput({ screenshot: "/missing.png", video: "/missing.webm", trace: "/missing.jsonl" });
  const passingBase = asPassing(base.tests[0]!);
  const passing = {
    ...passingBase,
    result: { ...passingBase.result, artifacts: [] },
  };
  const mutableInput = {
    ...base,
    tests: [{
      ...passing,
      result: {
        ...passing.result,
        steps: passing.result.steps.map((step) => ({ ...step })),
      },
    }],
  };
  const pending = writeReportBundle(mutableInput, path.join(fixture, "snapshot"));
  mutableInput.tests[0]!.result.steps[0]!.status = "failed";
  const result = await pending;

  assert.equal(result.report.status, "passed");
  assert.equal(result.report.tests[0]!.result.status, "passed");
  assert.equal(result.report.tests[0]!.result.steps[0]!.status, "passed");
});
