import { createHash } from "node:crypto";

import type { AgentLoopEvent, AgentLoopLane, AgentLoopStatus, AgentLoopTrace } from "./model.js";
import { hardMaximumEvents } from "./limits.js";
import { cleanText, isRecord } from "./sanitize.js";
import { normalizeAgentLoopTrace } from "./normalize-trace.js";

const laneOrder: readonly AgentLoopLane[] = ["agent", "model", "tool", "approval", "desktop", "browser", "system"];
export const maximumAgentLoopListCases = 500;
export const maximumAgentLoopListEvents = 100_000;
const maximumTimelineEventsPerCase = 200;
const maximumLedgerEventsPerCase = 50;

export interface AgentLoopListOptions {
  readonly title?: string;
  readonly warnings?: readonly string[];
}

export function renderAgentLoopListHTML(
  inputs: readonly AgentLoopTrace[],
  options: AgentLoopListOptions = {},
): string {
  if (inputs.length === 0) throw new Error("Agent-loop list requires at least one trace.");
  if (inputs.length > maximumAgentLoopListCases) throw new Error(`Agent-loop list exceeds ${maximumAgentLoopListCases} cases.`);
  let declaredEventCount = 0;
  for (const input of inputs) {
    if (!isRecord(input) || !Array.isArray(input.events)) continue;
    declaredEventCount += input.events.length;
    if (declaredEventCount > maximumAgentLoopListEvents) throw new Error(`Agent-loop list exceeds ${maximumAgentLoopListEvents} events.`);
  }
  const traces = inputs.map((trace) => normalizeAgentLoopTrace(trace, { maxEvents: hardMaximumEvents }));
  let eventCount = 0;
  for (const trace of traces) {
    eventCount += trace.events.length;
    if (eventCount > maximumAgentLoopListEvents) throw new Error(`Agent-loop list exceeds ${maximumAgentLoopListEvents} events.`);
  }

  const title = cleanText(options.title ?? "Agent Loop Cases");
  const suiteWarnings = (options.warnings ?? []).slice(0, 100).map(cleanText);
  const statuses = traces.map(caseStatus);
  const overall = suiteStatus(statuses);
  const styleSheet = `${styles}\n${layoutStyles(traces)}`;
  const contentSecurityPolicy = [
    "default-src 'none'",
    `style-src 'sha256-${createHash("sha256").update(styleSheet).digest("base64")}'`,
    "img-src 'none'", "media-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join("; ");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}"><meta name="color-scheme" content="light">
<title>${html(title)} — SurfaceLoom Agent Loop Cases</title><style>${styleSheet}</style></head>
<body><main><header><div><p class="eyebrow">SurfaceLoom · Agent loop suite</p><h1>${html(title)}</h1></div>
<div class="meta"><span>${traces.length} cases</span><span class="state status-${overall}">${overall}</span></div></header>
<p class="notice">Case summaries contain structural metadata only. Prompts, tool arguments, outputs, credentials, and user paths are omitted or redacted during import.</p>
${suiteWarnings.length === 0 ? "" : `<details class="suite-warnings"><summary>${suiteWarnings.length} batch warning${suiteWarnings.length === 1 ? "" : "s"} omitted</summary></details>`}
<details class="case-index"${traces.length <= 12 ? " open" : ""}><summary>Case index · ${traces.length} items</summary><nav aria-label="Case index"><ol>${traces.map((trace, index) => `<li><a href="#case-${index + 1}"><span>${String(index + 1).padStart(2, "0")}</span>${html(trace.id)}<small class="status-${statuses[index] ?? "unknown"}">${statuses[index] ?? "unknown"}</small></a></li>`).join("")}</ol></nav></details>
<section class="cases" aria-label="Agent loop cases">${traces.map(renderCase).join("\n")}</section>
</main></body></html>\n`;
}

function renderCase(trace: AgentLoopTrace, caseIndex: number): string {
  const status = caseStatus(trace);
  const timelineEvents = sampleEvents(trace.events, maximumTimelineEventsPerCase);
  const ledgerEvents = sampleEvents(trace.events, maximumLedgerEventsPerCase);
  const failedEvents = trace.events.filter((event) => event.status === "failed").length;
  const blockedEvents = trace.events.filter((event) => event.status === "blocked").length;
  const history = [
    failedEvents === 0 ? "" : `${failedEvents} failed event${failedEvents === 1 ? "" : "s"}`,
    blockedEvents === 0 ? "" : `${blockedEvents} blocked event${blockedEvents === 1 ? "" : "s"}`,
  ].filter(Boolean).join(" · ");
  const warnings = trace.warnings.length === 0
    ? ""
    : `<details class="warnings"><summary>${trace.warnings.length} import warning${trace.warnings.length === 1 ? "" : "s"} omitted</summary></details>`;
  return `<article id="case-${caseIndex + 1}"><div class="case-head"><div><p class="case-number">Case ${String(caseIndex + 1).padStart(2, "0")} · ${html(trace.source)}</p><h2>${html(trace.id)}</h2></div>
<div class="case-meta"><span>${trace.events.length} events</span><span>${formatDuration(trace.durationMs)}</span><span class="state status-${status}">${status}</span></div></div>
${history === "" ? "" : `<p class="history">History: ${html(history)}; final status: ${status}.</p>`}
<div class="mini-timeline" aria-label="${attribute(trace.id)} timeline">${laneOrder.map((lane) => renderLane(timelineEvents, lane, caseIndex)).join("")}</div>
${warnings}<details class="event-list"><summary>${ledgerEvents.length === trace.events.length ? `Show ${trace.events.length} events` : `Show ${ledgerEvents.length} sampled events · ${trace.events.length} total`}</summary><ol>${ledgerEvents.map(renderEvent).join("")}</ol></details></article>`;
}

function renderLane(events: readonly AgentLoopEvent[], lane: AgentLoopLane, caseIndex: number): string {
  const marks = events.flatMap((event, eventIndex) => event.lane === lane
    ? [`<span class="mark case-${caseIndex}-event-${eventIndex} lane-${lane} status-${event.status}" title="${attribute(`${event.name} · ${formatDuration(event.offsetMs)} · ${event.status}`)}"></span>`]
    : []).join("");
  return `<div class="lane"><strong>${laneLabel(lane)}</strong><div class="track">${marks}</div></div>`;
}

function renderEvent(event: AgentLoopEvent): string {
  const metadata = event.details === undefined || Object.keys(event.details).length === 0 ? "" : `<span class="metadata">metadata available</span>`;
  return `<li><span class="time">${formatDuration(event.offsetMs)}</span><span class="tag lane-${event.lane}">${laneLabel(event.lane)}</span><strong>${html(event.name)}</strong><span class="state status-${event.status}">${event.status}</span>${metadata}</li>`;
}

function layoutStyles(traces: readonly AgentLoopTrace[]): string {
  return traces.flatMap((trace, caseIndex) => {
    const maximum = Math.max(1, trace.durationMs);
    return sampleEvents(trace.events, maximumTimelineEventsPerCase).map((event, eventIndex) => {
      const left = Math.min(99.2, event.offsetMs / maximum * 100);
      const width = event.durationMs === undefined ? 0.8 : Math.max(0.8, event.durationMs / maximum * 100);
      return `.case-${caseIndex}-event-${eventIndex}{left:${left.toFixed(3)}%;width:${Math.min(100 - left, width).toFixed(3)}%}`;
    });
  }).join("");
}

function sampleEvents(events: readonly AgentLoopEvent[], limit: number): readonly AgentLoopEvent[] {
  if (events.length <= limit) return events;
  const selected = new Set<number>([0, events.length - 1]);
  const priority = events.flatMap((event, index) => event.status === "failed" || event.status === "blocked" ? [index] : []);
  for (const index of evenlySpaced(priority, Math.max(0, limit - selected.size))) selected.add(index);
  for (const index of evenlySpaced(events.map((_, index) => index), Math.max(0, limit - selected.size))) selected.add(index);
  for (let index = 0; selected.size < limit && index < events.length; index += 1) selected.add(index);
  return [...selected].sort((left, right) => left - right).slice(0, limit).map((index) => events[index]!);
}

function evenlySpaced(indexes: readonly number[], count: number): readonly number[] {
  if (count <= 0 || indexes.length === 0) return [];
  if (indexes.length <= count) return indexes;
  if (count === 1) return [indexes[indexes.length - 1]!];
  return Array.from({ length: count }, (_, slot) => indexes[Math.round(slot * (indexes.length - 1) / (count - 1))]!);
}

function caseStatus(trace: AgentLoopTrace): AgentLoopStatus {
  for (let index = trace.events.length - 1; index >= 0; index -= 1) {
    const status = trace.events[index]?.status;
    if (status !== undefined && status !== "unknown") return status;
  }
  return "unknown";
}

function suiteStatus(statuses: readonly AgentLoopStatus[]): AgentLoopStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("running")) return "running";
  if (statuses.every((status) => status === "passed")) return "passed";
  return "unknown";
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

const styles = `
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}main{width:min(1240px,calc(100% - 32px));margin:auto;padding:42px 0 80px}header,.case-head{display:flex;justify-content:space-between;gap:24px;align-items:end}.eyebrow,.case-number{font:700 .76rem ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:#52667d;margin:0}h1{font-size:clamp(2rem,5vw,3.7rem);margin:.2rem 0 0}h2{font-size:1.35rem;margin:.2rem 0 0}.meta,.case-meta{display:flex;gap:8px;flex-wrap:wrap}.meta span,.case-meta span,.tag,.state{font:650 .72rem ui-monospace,monospace;border:1px solid #ced7e2;border-radius:999px;padding:5px 9px;background:#fff}.notice,.history{margin:24px 0;padding:14px 16px;border:1px solid #d6dfe9;border-radius:12px;background:#fff;color:#526174}.suite-warnings{margin:-10px 0 24px;color:#8a5400}.suite-warnings>summary{cursor:pointer;font-weight:700}.suite-warnings ul{margin:8px 0 0}.case-index{margin:24px 0}.case-index>summary{cursor:pointer;font-weight:750;color:#44546a}.case-index nav{margin:12px 0 0}nav ol{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}nav a{display:grid;grid-template-columns:36px 1fr auto;align-items:center;gap:10px;color:inherit;text-decoration:none;background:#fff;border:1px solid #d6dfe9;border-radius:12px;padding:12px}nav a:hover{border-color:#8092aa}nav a>span{font:700 .72rem ui-monospace,monospace;color:#66768b}nav small{font:700 .7rem ui-monospace,monospace}.cases{display:grid;gap:18px}article{scroll-margin-top:16px;background:#fff;border:1px solid #d6dfe9;border-radius:16px;padding:18px;box-shadow:0 12px 36px #1c35550c}.case-meta{justify-content:end}.history{font-size:.78rem;margin:14px 0 0;padding:8px 10px;background:#fff8eb;border-color:#f0d7aa}.mini-timeline{margin-top:16px;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;padding:8px 0}.lane{display:grid;grid-template-columns:78px 1fr;gap:10px;align-items:center}.lane>strong{font:700 .65rem ui-monospace,monospace;text-transform:uppercase}.track{height:22px;position:relative;border-left:1px solid #dbe3ec;border-right:1px solid #dbe3ec;background:linear-gradient(90deg,transparent 49.8%,#e8edf3 50%,transparent 50.2%)}.mark{position:absolute;top:5px;height:12px;min-width:5px;border-radius:4px;border:1px solid #ffffffaa;box-shadow:0 1px 5px #1e293b30}.lane-agent{background:#8b5cf6}.lane-model{background:#2563eb}.lane-tool{background:#0f9f8f}.lane-approval{background:#e68719}.lane-desktop{background:#d946ef}.lane-browser{background:#0891b2}.lane-system{background:#64748b}.status-failed{color:#b42333;outline:2px solid #c52d3a}.status-blocked{color:#a65300;outline:2px dashed #bc6b00}.status-passed{color:#087443}.status-running{color:#334155}.warnings,.event-list{margin-top:12px;color:#526174}.warnings>summary,.event-list>summary{cursor:pointer;font-weight:700;color:#44546a}.warnings ul{margin:8px 0 0}.event-list>ol{list-style:none;padding:10px 0 0;margin:0;display:grid;gap:7px}.event-list li{display:grid;grid-template-columns:72px 80px minmax(120px,1fr) 86px;gap:10px;align-items:center;background:#f8fafc;border:1px solid #e0e6ee;border-radius:9px;padding:9px 11px}.event-list li>details{grid-column:3/-1}.time{font:600 .72rem ui-monospace,monospace;color:#526174}.tag{color:white;text-align:center;border:0}.state{text-align:center;outline:0}.event-list pre{white-space:pre-wrap;word-break:break-word;background:#eef2f6;padding:10px;border-radius:8px}@media(max-width:700px){header,.case-head{align-items:start;flex-direction:column}.case-meta{justify-content:start}.event-list li{grid-template-columns:64px 76px 1fr}.event-list .state{grid-column:3}.lane{grid-template-columns:64px 1fr}}
`;
