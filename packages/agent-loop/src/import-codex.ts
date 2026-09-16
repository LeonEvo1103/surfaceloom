import { buildTrace, offsetFromTimestamp, validTimestamp } from "./build-trace.js";
import { maximumTraceInputBytes, recordBudgetFor, resolveMaxEvents } from "./limits.js";
import type { AgentLoopEvent, AgentLoopLane, AgentLoopPhase, AgentLoopStatus, AgentLoopTrace, ImportOptions } from "./model.js";
import { parseJSONLines } from "./parse-jsonl.js";
import { cleanText, isRecord, numberField, safeObject, stringField } from "./sanitize.js";

export function importCodexRolloutJSONL(input: string, options: ImportOptions = {}): AgentLoopTrace {
  if (Buffer.byteLength(input, "utf8") > maximumTraceInputBytes) throw new Error("Codex trace exceeds 32 MiB.");
  const maxEvents = resolveMaxEvents(options.maxEvents);
  const parsed = parseJSONLines(input, recordBudgetFor(maxEvents));
  const records = parsed.records;
  let originMs: number | undefined;
  records.forEach((record) => {
    const timestamp = Date.parse(stringField(record, "timestamp") ?? "");
    if (Number.isFinite(timestamp) && (originMs === undefined || timestamp < originMs)) originMs = timestamp;
  });
  const events: AgentLoopEvent[] = [];
  const warnings: string[] = [];

  records.forEach((record, index) => {
    const mapped = mapRecord(record, index + 1, originMs);
    if (mapped !== undefined) events.push(mapped);
  });
  if (records.length === 0 && input.trim() !== "") warnings.push("No valid JSON records were found.");
  if (parsed.invalidLines > 0) warnings.push(`Ignored ${parsed.invalidLines} incomplete or invalid JSONL lines.`);
  if (parsed.truncated) warnings.push("Stopped parsing after the JSONL record budget.");
  return buildTrace("codex", events, warnings, { ...options, maxEvents }, validTimestamp(
    originMs === undefined ? undefined : new Date(originMs).toISOString(),
  ));
}

function mapRecord(record: Record<string, unknown>, sequence: number, originMs?: number): AgentLoopEvent | undefined {
  const topType = stringField(record, "type") ?? "unknown";
  const payload = isRecord(record.payload) ? record.payload : {};
  const payloadType = stringField(payload, "type");
  const descriptor = describe(topType, payloadType, payload);
  if (descriptor === undefined) return undefined;
  const ordinal = numberField(record, "ordinal") ?? sequence;
  const correlationId = correlation(payload);
  return {
    id: `codex-${sequence}`,
    offsetMs: offsetFromTimestamp(record.timestamp, originMs, Math.max(0, ordinal - 1)),
    lane: descriptor.lane,
    phase: descriptor.phase,
    name: cleanText(descriptor.name),
    status: descriptor.status,
    ...(correlationId === undefined ? {} : { correlationId: cleanText(correlationId) }),
    ...(descriptor.summary === undefined ? {} : { summary: descriptor.summary }),
    ...(descriptor.details === undefined ? {} : { details: descriptor.details }),
  };
}

interface Description {
  readonly lane: AgentLoopLane;
  readonly phase: AgentLoopPhase;
  readonly name: string;
  readonly status: AgentLoopStatus;
  readonly summary?: string;
  readonly details?: ReturnType<typeof safeObject>;
}

function describe(topType: string, payloadType: string | undefined, payload: Record<string, unknown>): Description | undefined {
  if (topType === "response_item") return describeResponse(payloadType, payload);
  if (topType === "event_msg") return describeEvent(payloadType, payload);
  if (topType === "session_meta") return { lane: "system", phase: "start", name: "session", status: "running" };
  if (topType === "turn_context") return { lane: "agent", phase: "start", name: "turn.context", status: "running" };
  if (topType === "token_usage_record") return { lane: "model", phase: "instant", name: "token.usage", status: "passed", details: safeObject(payload.usage) };
  if (topType === "world_state") return { lane: "system", phase: "instant", name: "world.state", status: "passed", summary: "State payload omitted" };
  return undefined;
}

function describeResponse(type: string | undefined, payload: Record<string, unknown>): Description {
  if (type === "custom_tool_call" || type === "function_call") {
    return { lane: "tool", phase: "start", name: stringField(payload, "name") ?? "tool.call", status: "running", summary: "Arguments omitted" };
  }
  if (type === "custom_tool_call_output" || type === "function_call_output") {
    return { lane: "tool", phase: "finish", name: "tool.output", status: "passed", summary: "Output omitted" };
  }
  if (type === "message") {
    const role = stringField(payload, "role") ?? "unknown";
    return { lane: role === "user" ? "agent" : "model", phase: "instant", name: `${role}.message`, status: "passed", summary: "Message content omitted" };
  }
  if (type === "reasoning") return { lane: "model", phase: "instant", name: "reasoning", status: "passed", summary: "Reasoning content omitted" };
  return { lane: "system", phase: "instant", name: `response.${type ?? "unknown"}`, status: "unknown" };
}

function describeEvent(type: string | undefined, payload: Record<string, unknown>): Description {
  if (type === "task_started") return { lane: "agent", phase: "start", name: "task", status: "running" };
  if (type === "task_completed") return { lane: "agent", phase: "finish", name: "task", status: "passed" };
  if (type === "task_failed") return { lane: "agent", phase: "finish", name: "task", status: "failed" };
  if (type === "token_count") return { lane: "model", phase: "instant", name: "token.count", status: "passed", details: safeObject(payload.info) };
  if (type === "item_completed") {
    const item = isRecord(payload.item) ? payload.item : {};
    const itemType = stringField(item, "type") ?? "item";
    return { lane: itemType.includes("tool") ? "tool" : "agent", phase: "finish", name: `item.${itemType}`, status: "passed" };
  }
  return { lane: "system", phase: "instant", name: `event.${type ?? "unknown"}`, status: "unknown" };
}

function correlation(payload: Record<string, unknown>): string | undefined {
  return stringField(payload, "call_id") ?? stringField(payload, "turn_id") ?? stringField(payload, "id");
}
