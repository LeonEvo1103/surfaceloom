import { createHash } from "node:crypto";

import type { AgentLoopEvent, AgentLoopLane, AgentLoopTrace } from "./model.js";
import { hardMaximumEvents } from "./limits.js";
import { normalizeAgentLoopTrace } from "./normalize-trace.js";
import { cleanText } from "./sanitize.js";

const laneOrder: readonly AgentLoopLane[] = ["agent", "model", "tool", "approval", "desktop", "browser", "system"];

export interface AgentLoopRenderOptions { readonly title?: string; }

export function renderAgentLoopHTML(input: AgentLoopTrace, options: AgentLoopRenderOptions = {}): string {
  const trace = normalizeAgentLoopTrace(input, { maxEvents: hardMaximumEvents });
  const displayTitle = options.title === undefined ? trace.id : safePresentationTitle(options.title);
  const maximum = Math.max(1, trace.durationMs);
  const eventIndexes = new Map(trace.events.map((event, index) => [event, index]));
  const lanes = laneOrder.map((lane) => renderLane(
    lane,
    trace.events.filter((event) => event.lane === lane),
    eventIndexes,
  )).join("\n");
  const styleSheet = `${styles}\n${layoutStyles(trace.events, maximum)}`;
  const warningMarkup = trace.warnings.length === 0 ? "" : `<aside><strong>Import warnings</strong><p>${trace.warnings.length} warning${trace.warnings.length === 1 ? "" : "s"} omitted from shared output.</p></aside>`;
  const contentSecurityPolicy = [
    "default-src 'none'",
    `style-src 'sha256-${createHash("sha256").update(styleSheet).digest("base64")}'`,
    "img-src 'none'", "media-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join("; ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}"><meta name="color-scheme" content="light">
<title>${html(displayTitle)} — SurfaceLoom Agent Loop</title><style>${styleSheet}</style></head>
<body><main><header><div><p class="eyebrow">SurfaceLoom · Agent loop</p><h1>${html(displayTitle)}</h1></div>
<div class="meta"><span>${html(trace.source)}</span><span>${trace.events.length} events</span><span>${formatDuration(trace.durationMs)}</span></div></header>
<p class="notice">Content, prompts, tool arguments, outputs, credentials, and user paths are omitted or redacted during import.</p>
${warningMarkup}<section class="timeline" aria-label="Agent loop timeline">${axis(maximum)}${lanes}</section>
<section><h2>Event ledger</h2><ol class="ledger">${trace.events.map(renderLedgerEvent).join("")}</ol></section>
</main></body></html>\n`;
}

function renderLane(
  lane: AgentLoopLane,
  events: readonly AgentLoopEvent[],
  eventIndexes: ReadonlyMap<AgentLoopEvent, number>,
): string {
  const marks = events.map((event) => {
    const title = `${event.name} · ${formatDuration(event.offsetMs)} · ${event.status}`;
    return `<span class="mark event-${eventIndexes.get(event) ?? 0} lane-${lane} status-${event.status}" title="${attribute(title)}"><span>${html(event.name)}</span></span>`;
  }).join("");
  return `<div class="lane"><strong>${laneLabel(lane)}</strong><div class="track">${marks}</div></div>`;
}

function layoutStyles(events: readonly AgentLoopEvent[], maximum: number): string {
  return events.map((event, index) => {
    const left = Math.min(99.4, event.offsetMs / maximum * 100);
    const width = event.durationMs === undefined ? 0.65 : Math.max(0.65, event.durationMs / maximum * 100);
    return `.event-${index}{left:${left.toFixed(3)}%;width:${Math.min(100 - left, width).toFixed(3)}%}`;
  }).join("");
}

function axis(maximum: number): string {
  return `<div class="axis"><strong>Lane</strong><div><span>0</span><span>${formatDuration(maximum / 2)}</span><span>${formatDuration(maximum)}</span></div></div>`;
}

function renderLedgerEvent(event: AgentLoopEvent): string {
  const metadata = event.details === undefined || Object.keys(event.details).length === 0 ? "" : `<span class="metadata">metadata available</span>`;
  return `<li><span class="time">${formatDuration(event.offsetMs)}</span><span class="tag lane-${event.lane}">${laneLabel(event.lane)}</span><strong>${html(event.name)}</strong><span class="state status-${event.status}">${html(event.status)}</span>${metadata}</li>`;
}

function laneLabel(lane: AgentLoopLane): string {
  return ({ agent: "Agent", model: "Model", tool: "Tool", approval: "Approval", desktop: "Desktop", browser: "Browser", system: "System" })[lane];
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(2)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${((milliseconds % 60_000) / 1000).toFixed(1)}s`;
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? character);
}

function attribute(value: string): string { return html(value); }

function safePresentationTitle(value: string): string {
  const title = cleanText(value).trim().slice(0, 120);
  return title === "" ? "Agent loop" : title;
}

const styles = `
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}main{width:min(1240px,calc(100% - 32px));margin:auto;padding:42px 0 80px}header{display:flex;justify-content:space-between;gap:24px;align-items:end}.eyebrow{font:700 .76rem ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:#52667d;margin:0}h1{font-size:clamp(2rem,5vw,3.7rem);margin:.2rem 0 0}.meta{display:flex;gap:8px;flex-wrap:wrap}.meta span,.tag,.state{font:650 .72rem ui-monospace,monospace;border:1px solid #ced7e2;border-radius:999px;padding:5px 9px;background:#fff}.notice,aside{margin:24px 0;padding:14px 16px;border:1px solid #d6dfe9;border-radius:12px;background:#fff;color:#526174}.timeline{background:#fff;border:1px solid #d6dfe9;border-radius:16px;padding:16px;overflow:hidden;box-shadow:0 12px 36px #1c35550c}.axis,.lane{display:grid;grid-template-columns:86px 1fr;gap:12px;align-items:center}.axis{font-size:.72rem;color:#64748b}.axis div{display:flex;justify-content:space-between}.lane>strong{font:700 .74rem ui-monospace,monospace;text-transform:uppercase}.track{height:44px;position:relative;border-left:1px solid #dbe3ec;border-right:1px solid #dbe3ec;background:linear-gradient(90deg,transparent 49.8%,#e8edf3 50%,transparent 50.2%)}.mark{position:absolute;top:8px;height:28px;min-width:6px;border-radius:7px;overflow:hidden;border:1px solid #ffffffaa;box-shadow:0 2px 8px #1e293b20}.mark span{display:none}.lane-agent{background:#8b5cf6}.lane-model{background:#2563eb}.lane-tool{background:#0f9f8f}.lane-approval{background:#e68719}.lane-desktop{background:#d946ef}.lane-browser{background:#0891b2}.lane-system{background:#64748b}.status-failed{outline:2px solid #c52d3a}.status-blocked{outline:2px dashed #bc6b00}.ledger{list-style:none;padding:0;display:grid;gap:8px}.ledger li{display:grid;grid-template-columns:72px 80px minmax(120px,1fr) 86px;gap:10px;align-items:center;background:#fff;border:1px solid #dce3eb;border-radius:11px;padding:11px 13px}.ledger p,.ledger details{grid-column:3/-1;margin:5px 0;color:#58677a}.time{font:600 .72rem ui-monospace,monospace;color:#526174}.tag{color:white;text-align:center;border:0}.state{text-align:center}.status-passed{color:#087443}.state.status-failed{color:#b42333;outline:0}.state.status-blocked{color:#a65300;outline:0}pre{white-space:pre-wrap;word-break:break-word;background:#f4f6f9;padding:10px;border-radius:8px}@media(max-width:700px){header{align-items:start;flex-direction:column}.ledger li{grid-template-columns:64px 76px 1fr}.ledger .state{grid-column:3}.lane{grid-template-columns:66px 1fr}.axis{grid-template-columns:66px 1fr}}
`;
