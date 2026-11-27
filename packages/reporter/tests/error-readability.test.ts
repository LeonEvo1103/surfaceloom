import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { writeReportBundle } from "../src/index.js";
import { createFixture, makeInput, pngEvidence, webmEvidence } from "./support.js";

test("report/v2 HTML and AI review show failed criteria with expected and actual values",
  async (context) => {
    const fixture = await createFixture(context);
    const paths = { screenshot: path.join(fixture, "failure.png"),
      video: path.join(fixture, "recording.webm"), trace: path.join(fixture, "events.jsonl") };
    await Promise.all([writeFile(paths.screenshot, pngEvidence()),
      writeFile(paths.video, webmEvidence()), writeFile(paths.trace, "{}\n")]);
    const input = makeInput(paths);
    const failed = input.tests[0]!;
    const withValues = { ...input, tests: [{ ...failed, result: { ...failed.result,
      error: { category: "assertion", message: "窗口仍然可见",
        expected: { visible: false }, actual: { visible: true } } } }, ...input.tests.slice(1)] };
    const result = await writeReportBundle(withValues, path.join(fixture, "report-output"));
    const html = await readFile(result.htmlPath, "utf8");
    const markdown = await readFile(result.aiReviewPath, "utf8");

    assert.match(html, /未通过的验收条件：<code>window-hidden<\/code>/u);
    assert.match(html, /期望：<code>\{&quot;visible&quot;:false\}<\/code>/u);
    assert.match(html, /实际：<code>\{&quot;visible&quot;:true\}<\/code>/u);
    assert.match(markdown, /  - 未通过的验收条件：`window-hidden`/u);
    assert.match(markdown, /  - 期望：\{"visible":false\}/u);
    assert.match(markdown, /  - 实际：\{"visible":true\}/u);
  });

test("report/v2 expected and actual are escaped, redacted and listed before failed criteria",
  async (context) => {
    const fixture = await createFixture(context);
    const paths = { screenshot: path.join(fixture, "failure.png"),
      video: path.join(fixture, "recording.webm"), trace: path.join(fixture, "events.jsonl") };
    await Promise.all([writeFile(paths.screenshot, pngEvidence()),
      writeFile(paths.video, webmEvidence()), writeFile(paths.trace, "{}\n")]);
    const secret = ["sk", "synthetic-v2-readability-value"].join("-");
    const input = makeInput(paths);
    const failed = input.tests[0]!;
    const hostile = { ...input, tests: [{ ...failed, result: { ...failed.result,
      error: { category: "assertion", message: "窗口仍然可见",
        expected: "</code><script>alert(1)</script>",
        actual: { note: `value ${secret}`, link: "[x](https://example.invalid/)" } } } },
    ...input.tests.slice(1)] };
    const result = await writeReportBundle(hostile, path.join(fixture, "report-output"));
    const html = await readFile(result.htmlPath, "utf8");
    const markdown = await readFile(result.aiReviewPath, "utf8");
    const report = await readFile(result.reportPath, "utf8");

    for (const text of [html, markdown, report]) assert.ok(!text.includes(secret));
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.match(html, /期望：<code>&quot;&lt;\/code&gt;&lt;script&gt;/u);
    assert.ok(!markdown.includes("[x]("), "values must not form Markdown links");
    const failedHtml = html.slice(html.indexOf("窗口仍然可见"));
    const failedMarkdown = markdown.slice(markdown.indexOf("窗口仍然可见"));
    assert.ok(failedHtml.indexOf("实际：") >= 0
      && failedHtml.indexOf("实际：") < failedHtml.indexOf("未通过的验收条件："));
    assert.ok(failedMarkdown.indexOf("- 实际：") >= 0
      && failedMarkdown.indexOf("- 实际：") < failedMarkdown.indexOf("- 未通过的验收条件："));
  });
