export const agentLoopSchemaVersion = "surfaceloom.agent-loop/v1" as const;

/** Namespaced runtime identifier, for example `openai/codex` or `acme/agent`. */
export type AgentLoopSource = string;
export type AgentLoopLane =
  | "agent"
  | "model"
  | "tool"
  | "desktop"
  | "browser"
  | "approval"
  | "system";
export type AgentLoopPhase = "start" | "finish" | "instant";
export type AgentLoopStatus = "running" | "passed" | "failed" | "blocked" | "unknown";

export type SafeValue = string | number | boolean | null | readonly SafeValue[] | SafeObject;
export interface SafeObject { readonly [key: string]: SafeValue; }

export interface AgentLoopEvent {
  readonly id: string;
  readonly offsetMs: number;
  readonly lane: AgentLoopLane;
  readonly phase: AgentLoopPhase;
  readonly name: string;
  readonly status: AgentLoopStatus;
  readonly durationMs?: number;
  readonly correlationId?: string;
  readonly summary?: string;
  readonly details?: SafeObject;
}

export interface AgentLoopTrace {
  readonly schemaVersion: typeof agentLoopSchemaVersion;
  readonly id: string;
  readonly title: string;
  readonly source: AgentLoopSource;
  readonly startedAt?: string;
  readonly durationMs: number;
  readonly events: readonly AgentLoopEvent[];
  readonly warnings: readonly string[];
}

export interface ImportOptions {
  readonly id?: string;
  readonly title?: string;
  readonly maxEvents?: number;
}
