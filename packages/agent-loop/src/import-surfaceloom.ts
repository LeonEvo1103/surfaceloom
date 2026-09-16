import { buildTrace, offsetFromTimestamp, validTimestamp } from "./build-trace.js";
import { maximumTraceInputBytes, recordBudgetFor, resolveMaxEvents } from "./limits.js";
import type { AgentLoopEvent, AgentLoopLane, AgentLoopStatus, AgentLoopTrace, ImportOptions } from "./model.js";
import { parseJSONLines } from "./parse-jsonl.js";
import { cleanText, isRecord, numberField, safeObject, stringField } from "./sanitize.js";

export function importSurfaceLoomTraceJSONL(input: string, options: ImportOptions = {}): AgentLoopTrace {
  if (Buffer.byteLength(input, "utf8") > maximumTraceInputBytes) throw new Error("SurfaceLoom trace exceeds 32 MiB.");
  const maxEvents = resolveMaxEvents(options.maxEvents);
  const parsed = parseJSONLines(input, recordBudgetFor(maxEvents));
  const records = parsed.records;
  let originMs: number | undefined;
  records.forEach((record) => {
    const timestamp = Date.parse(stringField(record, "timestamp") ?? "");
    if (Number.isFinite(timestamp) && (originMs === undefined || timestamp < originMs)) originMs = timestamp;
  });
  const events = pairOperationDurations(records.flatMap((record, index) => mapEvent(record, index, originMs)));
  const warnings: string[] = [];
  if (parsed.invalidLines > 0) warnings.push(`Ignored ${parsed.invalidLines} incomplete or invalid JSONL lines.`);
  if (parsed.truncated) warnings.push("Stopped parsing after the JSONL record budget.");
  return buildTrace("surfaceloom", events, warnings, { ...options, maxEvents }, validTimestamp(
    originMs === undefined ? undefined : new Date(originMs).toISOString(),
  ));
}

function pairOperationDurations(events: readonly AgentLoopEvent[]): AgentLoopEvent[] {
  const starts = new Map<string, number>();
  const result = events.map((event) => ({ ...event }));
  result.forEach((event, index) => {
    if (event.correlationId === undefined) return;
    if (event.phase === "start") {
      starts.set(event.correlationId, index);
      return;
    }
    if (event.phase !== "finish") return;
    const startIndex = starts.get(event.correlationId);
    if (startIndex === undefined) {
      delete event.durationMs;
      return;
    }
    const start = result[startIndex];
    if (start !== undefined) start.durationMs = Math.max(0, event.offsetMs - start.offsetMs);
    delete event.durationMs;
    starts.delete(event.correlationId);
  });
  return result;
}

function mapEvent(record: Record<string, unknown>, index: number, originMs?: number): AgentLoopEvent[] {
  const kind = stringField(record, "kind");
  if (kind === undefined) return [];
  const action = stringField(record, "action");
  const component = stringField(record, "componentId");
  const operationId = stringField(record, "operationId");
  const outcome = stringField(record, "outcome");
  const durationMs = numberField(record, "durationMs");
  return [{
    id: `surfaceloom-${index + 1}`,
    offsetMs: offsetFromTimestamp(record.timestamp, originMs, index),
    lane: laneFor(`${component ?? ""} ${action ?? ""}`),
    phase: kind === "operation.started" ? "start" : kind === "operation.finished" ? "finish" : "instant",
    name: cleanText(action ?? component ?? kind),
    status: statusFor(kind, outcome),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(operationId === undefined ? {} : { correlationId: cleanText(operationId) }),
    ...(isRecord(record.details) ? { details: safeObject(record.details) } : {}),
  }];
}

function laneFor(value: string): AgentLoopLane {
  if (/browser|dom|playwright/i.test(value)) return "browser";
  if (/approval|permission|sandbox/i.test(value)) return "approval";
  if (/tool|model|agent/i.test(value)) return /model/i.test(value) ? "model" : "tool";
  return "desktop";
}

function statusFor(kind: string, outcome: string | undefined): AgentLoopStatus {
  if (kind === "operation.started") return "running";
  if (outcome === "passed") return "passed";
  if (outcome === "failed") return "failed";
  if (outcome === "unsupported") return "blocked";
  return kind === "diagnostic" ? "unknown" : "passed";
}
