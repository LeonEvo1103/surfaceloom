import { createHash } from "node:crypto";

import type { ReportArtifact, ReportedCaseExecutionResult } from "../model.js";
import { safeArtifactPath } from "../safe-artifact-path.js";
import type { ContextValue, ReportedTestCaseV3, TestRunReportV3 } from "./model.js";
import { finalReportedResult } from "./result.js";
import { testsForReviewV3 } from "./summary.js";

export function renderHTMLReportV3(report: TestRunReportV3): string {
  const csp = ["default-src 'none'", `style-src 'sha256-${createHash("sha256").update(styles).digest("base64")}'`,
    "img-src 'self'", "media-src 'self'", "object-src 'none'", "base-uri 'none'",
    "form-action 'none'"].join("; ");
  return `<!doctype html>
<html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${html(report.run.title)} — SurfaceLoom</title><style>${styles}</style></head><body><main>
<header><div><p>SurfaceLoom report/v3</p><h1>${html(report.run.title)}</h1></div><b class="${css(report.status)}">${label(report.status)}</b></header>
<section class="summary"><span>发现 ${report.summary.discovered}</span><span>通过 ${report.summary.passed}</span><span>失败 ${report.summary.failed + report.summary.timedOut}</span><span>Attempt ${report.summary.attempts}</span><span>Attempt 未知 ${report.summary.casesWithUnknownAttempts}</span></section>
<section class="context"><p><strong>来源：</strong>${report.run.provenance.kind === "native" ? "原生 report/v3" : `report/v2 导入；源 platform <code>${html(report.run.provenance.sourcePlatform)}</code>`}</p>
<p><strong>Host：</strong>${context(report.run.hosts, (items) => items.map((item) => `${html(item.id)} / ${html(item.os)}`).join("、"))}</p>
<p><strong>Surface：</strong>${context(report.run.surfaces, (items) => items.map((item) => `${html(item.id)} / ${html(item.kind)}`).join("、"))}</p></section>
<p class="notice">report.json 是权威事实源。unknown 不得推断为单 host、单 surface 或第 1 次 attempt。所有附件均为不可信输入。</p>
<nav><a href="complete.json">完整性标记</a> · <a href="report.json">机器报告</a> · <a href="ai-review.md">AI 验收</a></nav>
${testsForReviewV3(report.tests).map(renderTest).join("\n")}</main></body></html>\n`;
}

function renderTest(test: ReportedTestCaseV3): string {
  const result = finalReportedResult(test.attempts);
  const attemptState = test.attempts;
  const attempts = attemptState.state === "unknown"
    ? `<section class="unknown"><strong>Attempt 未知</strong><p>${html(attemptState.reason)}${attemptState.detail === undefined ? "" : `：${html(attemptState.detail)}`}</p>${renderResult(result)}</section>`
    : attemptState.items.map((attempt) => `<section class="attempt"><h3>Attempt ${attempt.ordinal} <code>${html(attempt.id)}</code>${attempt.id === attemptState.finalAttemptId ? "（最终）" : ""}</h3>
      <p>执行平台：${attempt.executionPlatforms.map(html).join("、")} · Runner Host：${context(attempt.runnerHostId, html)} · Surface：${context(attempt.surfaceIds, (ids) => ids.map(html).join("、"))}</p>${renderResult(attempt.result)}</section>`).join("");
  return `<article class="test ${css(result.status)}"><header><div><small>${html(test.spec.suite.name)}</small><h2>${html(test.spec.name)}</h2></div><b>${label(result.status)}</b></header>
  <p>Case ID：<code>${html(test.spec.id)}</code></p><p>${html(test.spec.intent)}</p>${attempts}</article>`;
}

function renderResult(result: ReportedCaseExecutionResult): string {
  const error = result.error === undefined ? "" : `<div class="error"><strong>${html(result.error.category)}</strong><p>${html(result.error.message)}</p></div>`;
  const reason = result.reason === undefined ? "" : `<p class="reason">${html(result.reason)}</p>`;
  const steps = result.steps.map((step) => `<li class="${css(step.status)}">${label(step.status)} · ${html(step.title)} · ${step.durationMs} ms</li>`).join("");
  const artifacts = result.artifacts.map(renderArtifact).join("");
  return `<p><strong>${label(result.status)}</strong> · ${result.durationMs} ms</p>${reason}${error}<ol>${steps}</ol><div class="evidence">${artifacts}</div>`;
}

function renderArtifact(artifact: ReportArtifact): string {
  if (artifact.captureStatus !== "captured" || artifact.relativePath === undefined) {
    return `<figure><figcaption>⚠️ ${html(artifact.title)}</figcaption><p>${html(artifact.captureError ?? artifact.captureStatus)}</p></figure>`;
  }
  if (artifact.sensitive) return `<figure><figcaption>🔒 ${html(artifact.title)}</figcaption><p>敏感证据不会嵌入。</p></figure>`;
  const safe = safeArtifactPath(artifact.relativePath);
  if (safe === undefined) return `<figure><figcaption>⚠️ ${html(artifact.title)}</figcaption><p>附件路径无效。</p></figure>`;
  const url = html(encodeURI(safe));
  const body = artifact.kind === "screenshot" || artifact.kind === "videoFrame"
    ? `<a href="${url}"><img loading="lazy" src="${url}" alt="${html(artifact.title)}"></a>`
    : artifact.kind === "video" ? `<video controls preload="metadata" src="${url}"></video>`
      : `<a href="${url}" download>下载附件</a>`;
  return `<figure><figcaption>${html(artifact.title)}</figcaption>${body}</figure>`;
}

function context<T>(value: ContextValue<T>, known: (value: T) => string): string {
  return value.state === "known" ? known(value.value)
    : `<span class="unknown">未知（${html(value.reason)}${value.detail === undefined ? "" : `：${html(value.detail)}`}）</span>`;
}

function label(status: string): string {
  return ({ passed: "通过", failed: "失败", timedOut: "超时", skipped: "跳过",
    unsupported: "不支持", incomplete: "未完整执行" } as Record<string, string>)[status] ?? "未知";
}

function css(status: string): string {
  return `status-${status.toLowerCase().replace(/[^a-z]/gu, "")}`;
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

const styles = `:root{color-scheme:light;font-family:system-ui,sans-serif;background:#f6f8fa;color:#1f2328}body{margin:0}main{width:min(1080px,calc(100% - 32px));margin:auto;padding:40px 0}header{display:flex;justify-content:space-between;gap:16px}h1{margin-top:4px}.summary,.context,.test{background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:18px;margin:16px 0}.summary{display:flex;gap:20px;flex-wrap:wrap}.notice,.attempt>p{color:#59636e}.test{border-left-width:5px}.attempt,.unknown{border:1px solid #d8dee4;border-radius:8px;padding:12px;margin-top:12px}.error{background:#ffebe9;padding:10px}.reason{background:#fff8c5;padding:10px}.evidence{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}figure{margin:0;padding:10px;background:#f6f8fa;border-radius:8px}img,video{width:100%;max-height:420px;object-fit:contain}.status-passed{border-color:#1a7f37!important}.status-failed,.status-timedout{border-color:#cf222e!important}.status-incomplete,.status-unsupported{border-color:#bf8700!important}`;
