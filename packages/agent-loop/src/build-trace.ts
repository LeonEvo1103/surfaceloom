import {
  agentLoopSchemaVersion,
  type AgentLoopEvent,
  type AgentLoopSource,
  type AgentLoopTrace,
  type ImportOptions,
} from "./model.js";
import { cleanText, isAgentLoopSource, safeIdentifier } from "./sanitize.js";
import { resolveMaxEvents } from "./limits.js";

export function buildTrace(
  source: AgentLoopSource,
  events: readonly AgentLoopEvent[],
  warnings: readonly string[],
  options: ImportOptions,
  startedAt?: string,
): AgentLoopTrace {
  if (!isAgentLoopSource(source)) throw new Error("trace source is invalid.");
  const safeSource = source;
  const maxEvents = resolveMaxEvents(options.maxEvents);
  const ordered = events.map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.offsetMs - right.event.offsetMs || left.index - right.index)
    .slice(0, maxEvents);
  const traceWarnings = [...warnings];
  if (events.length > maxEvents) traceWarnings.push(`Dropped ${events.length - maxEvents} events after maxEvents.`);
  const orderedEvents = ordered.map(({ event }) => event);
  const durationMs = orderedEvents.reduce(
    (maximum, event) => Math.max(maximum, event.offsetMs + (event.durationMs ?? 0)),
    0,
  );
  return Object.freeze({
    schemaVersion: agentLoopSchemaVersion,
    id: safeIdentifier(options.id, `${safeSource.replace(/[^a-z0-9]+/g, "-")}-agent-loop`),
    title: cleanText(options.title ?? `${sourceName(safeSource)} agent loop`),
    source: safeSource,
    ...(startedAt === undefined ? {} : { startedAt }),
    durationMs,
    events: Object.freeze(orderedEvents.map((event) => Object.freeze(event))),
    warnings: Object.freeze(traceWarnings.map(cleanText)),
  });
}

function sourceName(source: AgentLoopSource): string {
  if (source === "surfaceloom") return "SurfaceLoom";
  return source.split(/[/.]/).at(-1)?.replace(/[-_]+/g, " ") ?? "Generic";
}

export function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

export function offsetFromTimestamp(value: unknown, originMs: number | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || originMs === undefined) return fallback;
  return Math.max(0, time - originMs);
}
