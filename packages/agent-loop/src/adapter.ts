import { importCodexRolloutJSONL } from "./import-codex.js";
import { importSurfaceLoomTraceJSONL } from "./import-surfaceloom.js";
import { maximumTraceInputBytes } from "./limits.js";
import type { AgentLoopSource, AgentLoopTrace, ImportOptions } from "./model.js";
import { normalizeAgentLoopTrace } from "./normalize-trace.js";
import { isAgentLoopSource } from "./sanitize.js";

export interface TraceAdapter {
  readonly id: AgentLoopSource | (string & {});
  detect(input: string): number;
  import(input: string, options?: ImportOptions): AgentLoopTrace;
}

export const builtInTraceAdapters: readonly TraceAdapter[] = Object.freeze([
  Object.freeze({ id: "codex", detect: detectCodex, import: importCodexRolloutJSONL }),
  Object.freeze({ id: "surfaceloom", detect: detectSurfaceLoom, import: importSurfaceLoomTraceJSONL }),
]);

export function importAgentLoop(
  input: string,
  options: ImportOptions & { readonly format?: string; readonly adapters?: readonly TraceAdapter[] } = {},
): AgentLoopTrace {
  if (Buffer.byteLength(input, "utf8") > maximumTraceInputBytes) throw new Error("Trace input exceeds 32 MiB.");
  const adapters = options.adapters ?? builtInTraceAdapters;
  adapters.forEach((adapter, index) => {
    if (!isAgentLoopSource(adapter.id)) throw new Error(`Trace adapter ${index + 1} has an invalid id.`);
  });
  if (options.format !== undefined && options.format !== "auto") {
    const selected = adapters.find((adapter) => adapter.id === options.format);
    if (selected === undefined) throw new Error(`Unknown trace format: ${options.format}`);
    return normalizeAgentLoopTrace(selected.import(input, options), options);
  }
  const ranked = adapters.map((adapter, index) => ({ adapter, index, score: detectScore(adapter, input, index) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = ranked[0];
  if (selected === undefined || selected.score === 0) throw new Error("No trace adapter recognized the input.");
  if (ranked[1]?.score === selected.score) throw new Error(`Trace format is ambiguous between ${selected.adapter.id} and ${ranked[1].adapter.id}.`);
  return normalizeAgentLoopTrace(selected.adapter.import(input, options), options);
}

function detectScore(adapter: TraceAdapter, input: string, index: number): number {
  try {
    return boundedScore(adapter.detect(input));
  } catch {
    throw new Error(`Trace adapter ${index + 1} detection failed.`);
  }
}

function detectCodex(input: string): number {
  return /"type"\s*:\s*"(?:session_meta|response_item|event_msg|turn_context)"/.test(input) ? 100 : 0;
}

function detectSurfaceLoom(input: string): number {
  return /"kind"\s*:\s*"(?:operation\.started|operation\.finished|diagnostic|attachment)"/.test(input) ? 90 : 0;
}

function boundedScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}
