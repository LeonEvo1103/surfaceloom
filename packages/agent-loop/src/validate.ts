import {
  agentLoopSchemaVersion,
  type AgentLoopEvent,
  type AgentLoopLane,
  type AgentLoopPhase,
  type AgentLoopStatus,
  type AgentLoopTrace,
} from "./model.js";
import { isAgentLoopSource } from "./sanitize.js";

const lanes = new Set<AgentLoopLane>(["agent", "model", "tool", "desktop", "browser", "approval", "system"]);
const phases = new Set<AgentLoopPhase>(["start", "finish", "instant"]);
const statuses = new Set<AgentLoopStatus>(["running", "passed", "failed", "blocked", "unknown"]);

export function validateAgentLoopTrace(trace: AgentLoopTrace): void {
  if (trace === null || typeof trace !== "object") throw new Error("Agent-loop trace must be an object.");
  if (trace.schemaVersion !== agentLoopSchemaVersion) throw new Error("Unsupported agent-loop schema version.");
  if (typeof trace.id !== "string" || typeof trace.title !== "string") throw new Error("trace id and title must be strings.");
  requireText("trace id", trace.id);
  requireText("trace title", trace.title);
  if (!isAgentLoopSource(trace.source)) throw new Error("trace source is invalid.");
  requireDuration("trace duration", trace.durationMs);
  if (trace.startedAt !== undefined && !Number.isFinite(Date.parse(trace.startedAt))) {
    throw new Error("trace startedAt must be an ISO timestamp.");
  }
  const ids = new Set<string>();
  if (!Array.isArray(trace.events)) throw new Error("trace events must be an array.");
  if (!Array.isArray(trace.warnings) || trace.warnings.length > 100 || trace.warnings.some((warning) => typeof warning !== "string")) {
    throw new Error("trace warnings are invalid.");
  }
  trace.warnings.forEach((warning) => requireText("trace warning", warning));
  let previousOffset = -1;
  trace.events.forEach((event) => {
    validateEvent(event);
    if (ids.has(event.id)) throw new Error(`Duplicate agent-loop event id: ${event.id}`);
    ids.add(event.id);
    if (event.offsetMs < previousOffset) throw new Error("Agent-loop events must be ordered by offsetMs.");
    previousOffset = event.offsetMs;
    if (event.offsetMs + (event.durationMs ?? 0) > trace.durationMs) {
      throw new Error(`${event.id} exceeds trace duration.`);
    }
  });
}

function validateEvent(event: AgentLoopEvent): void {
  if (event === null || typeof event !== "object") throw new Error("Agent-loop event must be an object.");
  if (typeof event.id !== "string" || typeof event.name !== "string") throw new Error("event id and name must be strings.");
  requireText("event id", event.id);
  requireText("event name", event.name);
  requireDuration(`${event.id}.offsetMs`, event.offsetMs);
  if (event.durationMs !== undefined) requireDuration(`${event.id}.durationMs`, event.durationMs);
  if (event.correlationId !== undefined) requireText(`${event.id}.correlationId`, event.correlationId);
  if (event.summary !== undefined) requireText(`${event.id}.summary`, event.summary);
  if (event.details !== undefined) validateSafeValue(event.details, new WeakSet<object>(), 0);
  if (!lanes.has(event.lane)) throw new Error(`${event.id} has an unknown lane.`);
  if (!phases.has(event.phase)) throw new Error(`${event.id} has an unknown phase.`);
  if (!statuses.has(event.status)) throw new Error(`${event.id} has an unknown status.`);
}

function validateSafeValue(value: unknown, seen: WeakSet<object>, depth: number): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("event details contain a non-finite number.");
    return;
  }
  if (typeof value !== "object") throw new Error("event details contain a non-JSON value.");
  if (seen.has(value)) throw new Error("event details contain a cycle.");
  if (depth > 8) throw new Error("event details exceed the maximum depth.");
  seen.add(value);
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  let count = 0;
  for (const entry of entries) {
    count += 1;
    if (count > 1_000) throw new Error("event details are too wide.");
    validateSafeValue(entry[1], seen, depth + 1);
  }
  seen.delete(value);
}

function requireText(label: string, value: string): void {
  if (value.trim() === "" || value.length > 240) throw new Error(`${label} must be 1..240 characters.`);
}

function requireDuration(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value))) {
    throw new Error(`${label} must be a finite non-negative duration.`);
  }
}
