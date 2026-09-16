import { buildTrace } from "./build-trace.js";
import type { AgentLoopEvent, AgentLoopTrace, ImportOptions } from "./model.js";
import { validateAgentLoopTrace } from "./validate.js";

export interface MergeOptions extends ImportOptions {
  /** Use relative offsets when false. Default: align absolute clocks when every trace has startedAt. */
  readonly alignClocks?: boolean;
}

export function mergeAgentLoopTraces(
  traces: readonly AgentLoopTrace[],
  options: MergeOptions = {},
): AgentLoopTrace {
  if (traces.length === 0) throw new Error("At least one trace is required.");
  traces.forEach(validateAgentLoopTrace);
  const alignClocks = options.alignClocks ?? true;
  const starts = traces.map((trace) => trace.startedAt === undefined ? undefined : Date.parse(trace.startedAt));
  const canAlign = alignClocks && starts.every((value) => value !== undefined && Number.isFinite(value));
  const origin = canAlign ? Math.min(...starts as number[]) : undefined;
  const events: AgentLoopEvent[] = [];
  traces.forEach((trace, traceIndex) => {
    const shift = origin === undefined ? 0 : (starts[traceIndex] as number) - origin;
    trace.events.forEach((event) => events.push({
      ...event,
      id: `${traceIndex + 1}:${event.id}`,
      offsetMs: event.offsetMs + shift,
      ...(event.correlationId === undefined ? {} : { correlationId: `${traceIndex + 1}:${event.correlationId}` }),
    }));
  });
  const warnings = traces.flatMap((trace) => trace.warnings.map((warning) => `${trace.source}: ${warning}`));
  if (alignClocks && !canAlign) warnings.push("Some traces had no absolute start time; relative offsets were used.");
  const merged = buildTrace("generic", events, warnings, {
    ...options,
    id: options.id ?? "merged-agent-loop",
    title: options.title ?? "Merged agent loop",
  }, origin === undefined ? undefined : new Date(origin).toISOString());
  validateAgentLoopTrace(merged);
  return merged;
}
