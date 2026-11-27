import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { errorValueLines } from "../../src/error-presentation.js";
import { writeReportV3Bundle, type ReportBundleV3Input } from "../../src/v3/index.js";
import { v3Input } from "./fixtures.js";

const secret = ["sk", "synthetic", "readability", "fixture", "value"].join("-");

test("failed results show the failed criterion, expected and actual values in HTML and AI review",
  async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "report-v3-readability-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const bundle = await writeReportV3Bundle(failedFinal({
      category: "criterion",
      message: "Observation assertion timedOut after 3 attempts for criterion verified: deadline.",
      expected: { count: 0, label: "<none>" },
      actual: { count: 1, apiToken: secret, inline: `value ${secret}`,
        link: "[x](https://example.invalid/)", note: "y".repeat(2000) },
    }), path.join(root, "bundle"));
    const html = await readFile(bundle.htmlPath, "utf8");
    const markdown = await readFile(bundle.aiReviewPath, "utf8");
    const report = await readFile(bundle.reportPath, "utf8");

    for (const text of [html, markdown, report]) assert.ok(!text.includes(secret));
    assert.match(html, /未通过的验收条件：<\/p><ul><li><code>verified<\/code> 最终结果由明确的最终尝试决定。/u);
    assert.match(html, /<dt>期望<\/dt><dd><code>\{&quot;count&quot;:0,&quot;label&quot;:&quot;&lt;none&gt;&quot;\}<\/code>/u);
    assert.match(html, /<dt>实际<\/dt><dd><code>\{&quot;count&quot;:1,&quot;apiToken&quot;:&quot;\[REDACTED\]&quot;/u);
    assert.match(html, /…（已截断，完整值见 report\.json）/u);
    assert.ok(!markdown.includes("[x]("), "values must not form Markdown links");
    // Values sit right under the message they explain, before the failed-criteria list.
    const finalMarkdown = markdown.slice(markdown.indexOf("for criterion verified"));
    const finalHtml = html.slice(html.indexOf("for criterion verified"));
    assert.ok(finalMarkdown.indexOf("- 实际：") >= 0
      && finalMarkdown.indexOf("- 实际：") < finalMarkdown.indexOf("- 未通过的验收条件："));
    assert.ok(finalHtml.indexOf("<dt>实际</dt>") >= 0
      && finalHtml.indexOf("<dt>实际</dt>") < finalHtml.indexOf("未通过的验收条件："));
    assert.match(markdown, /- 未通过的验收条件：`verified` 最终结果由明确的最终尝试决定。/u);
    assert.match(markdown, /- 期望：\{"count":0,"label":"\\<none\\>"\}/u);
    assert.match(markdown, /- 实际：\{"count":1,"apiToken":"\\\[REDACTED\\\]"/u);
    const actualLine = markdown.split("\n").find((line) => line.includes("- 实际："))!;
    assert.ok(actualLine.length < 700, "actual value must be capped in the AI review");
    assert.ok(report.includes("y".repeat(1000)), "report.json keeps the full redacted value");
  });

test("errors without expected/actual render no value placeholders", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "report-v3-readability-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await writeReportV3Bundle(failedFinal({ category: "body", message: "boom" }),
    path.join(root, "bundle"));
  const html = await readFile(bundle.htmlPath, "utf8");
  const markdown = await readFile(bundle.aiReviewPath, "utf8");
  assert.doesNotMatch(html, /<dt>期望|<dt>实际/u);
  assert.doesNotMatch(markdown, /- 期望：|- 实际：/u);
  assert.equal(bundle.report.status, "failed");
});

function failedFinal(error: Record<string, unknown>): ReportBundleV3Input {
  const input = v3Input();
  const attempts = input.tests[0]!.attempts;
  if (attempts.state !== "known") throw new Error("fixture must have known attempts");
  const final = attempts.items.find((attempt) => attempt.id === "attempt-2")!;
  (final as { result: unknown }).result = {
    status: "failed", startedAt: final.result.startedAt, durationMs: 5,
    steps: [{ id: "kernel.criterion.1", title: "最终结果由明确的最终尝试决定。", status: "failed",
      durationMs: 5, criterionIds: ["verified"] }],
    error,
  };
  return input;
}

test("display truncation never splits a surrogate pair", () => {
  const [line] = errorValueLines({ category: "criterion", message: "m", expected: "\u{1F600}".repeat(400) });
  assert.ok(line !== undefined && line.text.includes("已截断"));
  assert.doesNotMatch(line.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
});
