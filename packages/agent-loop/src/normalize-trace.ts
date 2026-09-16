import { buildTrace, validTimestamp } from "./build-trace.js";
import { hardMaximumEvents } from "./limits.js";
import { agentLoopSchemaVersion, type AgentLoopEvent, type AgentLoopLane, type AgentLoopPhase, type AgentLoopStatus, type AgentLoopTrace, type ImportOptions } from "./model.js";
import { cleanText, isAgentLoopSource, isRecord, safeIdentifier, safeObject, safeOptionalIdentifier } from "./sanitize.js";
import { validateAgentLoopTrace } from "./validate.js";

export function normalizeAgentLoopTrace(value: unknown, options: ImportOptions = {}): AgentLoopTrace {
  if (!isRecord(value)) throw new Error("Trace adapter must return an object.");
  if (value.schemaVersion !== agentLoopSchemaVersion) throw new Error("Trace adapter returned an unsupported schema version.");
  if (!isAgentLoopSource(value.source)) throw new Error("Trace adapter returned an invalid source.");
  if (!Array.isArray(value.events)) throw new Error("Trace adapter events must be an array.");
  if (value.events.length > hardMaximumEvents) throw new Error(`Trace adapter returned more than ${hardMaximumEvents} events.`);
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string")) {
    throw new Error("Trace adapter warnings must be an array of strings.");
  }
  if (value.warnings.length > 100) throw new Error("Trace adapter returned more than 100 warnings.");
  const startedAt = value.startedAt === undefined ? undefined : validTimestamp(value.startedAt);
  if (value.startedAt !== undefined && startedAt === undefined) throw new Error("Trace adapter returned an invalid startedAt.");
  const source = value.source;
  const normalized = buildTrace(
    source,
    value.events.map(normalizeEvent),
    value.warnings.map((_, index) => `Import warning ${index + 1}`),
    {
      ...options,
      id: options.id ?? safeIdentifier(value.id, `${source.replace(/[^a-z0-9]+/g, "-")}-trace`),
      title: cleanText(options.title ?? `${source} agent loop`),
    },
    startedAt,
  );
  validateAgentLoopTrace(normalized);
  return normalized;
}

function normalizeEvent(value: unknown, index: number): AgentLoopEvent {
  if (!isRecord(value)) throw new Error(`Trace adapter event ${index + 1} must be an object.`);
  if (typeof value.offsetMs !== "number") throw new Error(`Trace adapter event ${index + 1} has no numeric offsetMs.`);
  if (value.durationMs !== undefined && typeof value.durationMs !== "number") {
    throw new Error(`Trace adapter event ${index + 1} has an invalid durationMs.`);
  }
  const correlationId = safeOptionalIdentifier(value.correlationId);
  return {
    id: safeIdentifier(value.id, `event-${index + 1}`),
    offsetMs: value.offsetMs,
    lane: requiredString(value, "lane", index) as AgentLoopLane,
    phase: requiredString(value, "phase", index) as AgentLoopPhase,
    name: safeIdentifier(value.name, `${requiredString(value, "lane", index)}.event`),
    status: requiredString(value, "status", index) as AgentLoopStatus,
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
    ...(correlationId === undefined ? {} : { correlationId }),
    // Free-form summaries are deliberately omitted at this trust boundary.
    ...(value.details === undefined ? {} : { details: safeObject(value.details) }),
  };
}

function requiredString(value: Record<string, unknown>, key: string, index: number): string {
  const item = value[key];
  if (typeof item !== "string") throw new Error(`Trace adapter event ${index + 1} has an invalid ${key}.`);
  return item;
}
