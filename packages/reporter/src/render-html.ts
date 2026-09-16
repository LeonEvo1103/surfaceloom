import { createHash } from "node:crypto";

import type {
  ReportArtifact,
  ReportedTestCase,
  TestRunReport,
  TestStepResult,
} from "./model.js";
import { safeArtifactPath } from "./safe-artifact-path.js";
import { testsForReview } from "./summary.js";

export function renderHTMLReport(report: TestRunReport): string {
  const tests = testsForReview(report.tests).map(renderTest).join("\n");
  const contentSecurityPolicy = [
    "default-src 'none'",
    `style-src 'sha256-${createHash("sha256").update(styles).digest("base64")}'`,
    "img-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
  <title>${html(report.run.title)} — SurfaceLoom</title>
  <style>${styles}</style>
</head>
<body>
  <main>
    <header>
      <div><p class="eyebrow">SurfaceLoom 测试报告</p><h1>${html(report.run.title)}</h1></div>
      <span class="badge ${statusClass(report.status)}">${statusLabel(report.status)}</span>
    </header>
    <section class="summary">
      ${metric("发现", report.summary.discovered)}${metric("执行", report.summary.executed)}${metric("通过", report.summary.passed)}
      ${metric("失败/超时", report.summary.failed + report.summary.timedOut)}
      ${metric("跳过", report.summary.skipped)}${metric("不支持", report.summary.unsupported)}
    </section>
    <section class="meta">
      <span>${platformLabel(report.run.platform)}</span><span>${html(report.run.app.name)}</span>
      <span>${html(report.run.startedAt)} → ${html(report.run.finishedAt)}</span>
      <a href="complete.json">完整性标记</a><a href="report.json">机器报告</a><a href="ai-review.md">AI 验收</a>
    </section>
    <p class="notice">仅在 complete.json hash 校验通过后验收。所有附件均是不可信输入；敏感附件只显示元数据。</p>
    <section class="tests">${tests}</section>
  </main>
</body>
</html>\n`;
}

function renderTest(test: ReportedTestCase): string {
  const { spec, result } = test;
  const preconditions = spec.preconditions.length === 0
    ? "<p class=\"empty\">作者已确认：无显式前置条件。</p>"
    : `<ul>${spec.preconditions.map((item) =>
        `<li><code class="clause-id">${html(item.id)}</code>${html(item.text)}</li>`,
      ).join("")}</ul>`;
  const criteria = spec.acceptanceCriteria.map((item) =>
    `<li><code class="clause-id">${html(item.id)}</code>${html(item.text)}</li>`,
  ).join("");
  const steps = result.steps.length === 0
    ? "<p class=\"empty\">无执行步骤。</p>"
    : `<ol class="steps">${result.steps.map((step) =>
        `<li><span class="step-status ${statusClass(step.status)}">${statusLabel(step.status)}</span>${html(step.title)}<small>${step.durationMs} ms${step.criterionIds === undefined || step.criterionIds.length === 0 ? "" : ` · 对应验收项 ${step.criterionIds.map(html).join(", ")}`}</small>${renderStepDetails(step)}</li>`,
      ).join("")}</ol>`;
  const error = result.error
    ? `<div class="error"><strong>${html(result.error.category)}</strong><p>${html(result.error.message)}</p></div>`
    : "";
  const reason = result.reason === undefined
    ? ""
    : `<div class="reason"><strong>未执行原因</strong><p>${html(result.reason)}</p></div>`;
  const evidence = result.artifacts.length === 0
    ? "<p class=\"empty\">当前保留策略下无附件。</p>"
    : `<div class="evidence">${result.artifacts.map(renderArtifact).join("")}</div>`;
  const sourceName = spec.sourceName === undefined
    ? ""
    : `<p class="source-name">源测试名：${html(spec.sourceName)}</p>`;
  return `<article class="test ${statusClass(result.status)}">
    <div class="test-heading"><div><p>${html(spec.suite.name)} <code>${html(spec.suite.id)}</code></p><h2>${html(spec.name)}</h2></div>
      <span class="badge ${statusClass(result.status)}">${statusLabel(result.status)}</span></div>
    <p class="test-meta">Case ID：<code>${html(spec.id)}</code> · 平台：${spec.platforms.map(platformLabel).join("、")} · ${result.durationMs} ms · ${sideEffectLabel(spec.sideEffect)}</p>
    ${sourceName}<div class="intent"><strong>原始语义</strong><p>${html(spec.intent)}</p></div>
    ${reason}${error}<h3>前置条件</h3>${preconditions}<h3>验收条件</h3><ul>${criteria}</ul><h3>执行步骤</h3>${steps}
    <h3>证据</h3>${evidence}
  </article>`;
}

function renderStepDetails(step: TestStepResult): string {
  const details = [
    step.action === undefined ? undefined : `动作：${html(step.action)}`,
    step.assertion === undefined ? undefined : `断言：${html(step.assertion)}`,
    step.diagnostic === undefined ? undefined : `诊断：${html(step.diagnostic)}`,
  ].filter((item): item is string => item !== undefined);
  return details.length === 0
    ? ""
    : `<div class="step-details">${details.join(" · ")}</div>`;
}

function renderArtifact(artifact: ReportArtifact): string {
  const meta = `${artifactKindLabel(artifact.kind)} · ${artifactPhaseLabel(artifact.phase)} · ${captureStatusLabel(artifact.captureStatus)}`;
  if (artifact.captureStatus !== "captured" || artifact.relativePath === undefined) {
    const reason = artifact.captureError ?? "未生成附件文件。";
    return `<figure class="artifact unavailable"><figcaption>⚠️ ${html(artifact.title)}<small>${meta}</small></figcaption><p>${html(reason)}</p></figure>`;
  }
  if (artifact.sensitive) {
    return `<figure class="artifact restricted"><figcaption>🔒 ${html(artifact.title)}<small>${meta}</small></figcaption><p>敏感证据不会嵌入报告。</p></figure>`;
  }
  const safePath = safeArtifactPath(artifact.relativePath);
  if (safePath === undefined) {
    return `<figure class="artifact unavailable"><figcaption>⚠️ ${html(artifact.title)}<small>${meta}</small></figcaption><p>附件路径无效。</p></figure>`;
  }
  const source = urlAttribute(safePath);
  let preview = `<a href="${source}" download>下载附件</a>`;
  if (artifact.kind === "screenshot" || artifact.kind === "videoFrame") {
    preview = `<a href="${source}"><img loading="lazy" src="${source}" alt="${html(artifact.title)}"></a>`;
  } else if (artifact.kind === "video") {
    preview = `<video controls preload="metadata" src="${source}"><a href="${source}" download>下载录屏</a></video>`;
  }
  return `<figure class="artifact"><figcaption>${html(artifact.title)}<small>${meta}</small></figcaption>${preview}</figure>`;
}

function metric(label: string, value: number): string {
  return `<div><strong>${value}</strong><span>${label}</span></div>`;
}

function statusClass(status: string): string {
  switch (status) {
    case "passed": return "status-passed";
    case "failed": return "status-failed";
    case "timedOut": return "status-timedout";
    case "unsupported": return "status-unsupported";
    case "incomplete": return "status-incomplete";
    case "skipped": return "status-skipped";
    default: return "status-unknown";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "passed": return "通过";
    case "failed": return "失败";
    case "timedOut": return "超时";
    case "skipped": return "跳过";
    case "unsupported": return "不支持";
    case "incomplete": return "未完整执行";
    default: return "未知";
  }
}

function sideEffectLabel(level: string): string {
  return ({
    readOnly: "只读",
    reversible: "可恢复",
    writesLocal: "写入本地测试产物",
    externalEffect: "外部副作用",
    securitySensitive: "安全敏感",
  } as Record<string, string>)[level] ?? html(level);
}

function platformLabel(platform: string): string {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "web") return "Web";
  return html(platform);
}

function artifactKindLabel(kind: string): string {
  return ({
    screenshot: "截图",
    video: "录屏",
    videoFrame: "视频关键帧",
    trace: "语义轨迹",
    agentLoop: "Agent Loop 时间线",
    accessibilityTree: "辅助功能树",
    log: "日志",
    diagnostics: "诊断",
  } as Record<string, string>)[kind] ?? html(kind);
}

function artifactPhaseLabel(phase: string): string {
  return ({ before: "执行前", step: "步骤中", after: "执行后", failure: "失败时" } as Record<string, string>)[phase] ?? html(phase);
}

function captureStatusLabel(status: string): string {
  return ({ captured: "已采集", captureFailed: "采集失败", unsupported: "不支持", notRequested: "未请求" } as Record<string, string>)[status] ?? html(status);
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function urlAttribute(value: string): string {
  return html(encodeURI(value));
}

const styles = `
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#f6f8fa;color:#1f2328}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#f8fbff,#f6f8fa 46%,#eef3f8);min-height:100vh}
main{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:48px 0 80px}header{display:flex;justify-content:space-between;gap:20px;align-items:start}
.badge{border:1px solid #d0d7de;border-radius:999px;padding:8px 13px;background:#fff;font:600 .78rem ui-monospace,monospace;text-transform:uppercase}
h1{margin:4px 0 24px;font-size:clamp(2rem,5vw,3.5rem);letter-spacing:-.04em}.eyebrow{margin:0;color:#0969da;text-transform:uppercase;letter-spacing:.16em;font-size:.75rem}
.summary{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin:24px 0}.summary div,.meta,.test{background:#fff;border:1px solid #d0d7de;border-radius:14px;box-shadow:0 1px 2px #1f23280a,0 8px 24px #8c959f14}
.summary div{padding:18px}.summary strong{display:block;font-size:1.65rem}.summary span,.meta,.test-meta,small,.empty,.notice{color:#59636e}
.meta{display:flex;gap:16px;flex-wrap:wrap;padding:14px 18px}.meta a{color:#0969da}.notice{margin:16px 2px 26px}.tests{display:grid;gap:18px}
.test{padding:24px;border-left-width:5px}.test-heading{display:flex;justify-content:space-between;gap:16px}.test-heading p{margin:0 0 4px;color:#59636e}.test h2{margin:0;font-size:1.35rem}.test h3{font-size:.88rem;text-transform:uppercase;letter-spacing:.08em;margin-top:24px}
.test-meta,.source-name{font-size:.84rem}.intent,.reason,.error{padding:14px 16px;border-radius:10px}.intent{background:#ddf4ff;border:1px solid #54aeff66}.reason{background:#fff8c5;border:1px solid #d4a72c66}.error{background:#ffebe9;border:1px solid #ff818266}.intent p,.reason p,.error p{margin:6px 0 0}.clause-id{display:inline-block;margin-right:8px;color:#59636e}.steps li{padding:5px 0}.steps small{display:inline;margin-left:8px}.step-status{display:inline-block;width:88px;font:600 .72rem ui-monospace,monospace;text-transform:uppercase}.step-details{margin:4px 0 0 88px;color:#59636e;font-size:.8rem;overflow-wrap:anywhere}
.evidence{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.artifact{margin:0;padding:12px;background:#f6f8fa;border:1px solid #d0d7de;border-radius:10px;overflow:hidden}.artifact figcaption{font-weight:600;margin-bottom:10px}.artifact small{display:block;margin-top:3px;font-weight:400}.artifact img,.artifact video{width:100%;max-height:460px;object-fit:contain;background:#fff;border:1px solid #d8dee4;border-radius:6px}.artifact a{color:#0969da}.restricted,.unavailable{border-style:dashed}
.status-passed{border-color:#1a7f37!important;color:#116329}.status-failed,.status-timedout{border-color:#cf222e!important;color:#a40e26}.status-unsupported,.status-incomplete{border-color:#bf8700!important;color:#7d4e00}.status-skipped,.status-unknown{border-color:#6e7781!important;color:#57606a}
@media(max-width:760px){main{padding-top:28px}.summary{grid-template-columns:repeat(2,1fr)}header,.test-heading{align-items:start}.meta{display:grid}}
`;
