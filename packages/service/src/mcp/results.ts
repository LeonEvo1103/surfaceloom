import type { CallToolResult } from "@modelcontextprotocol/server";

import type { StoredRunRecord } from "../stores/contracts.js";

export function toolResult(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

export function toolError(cause: unknown): CallToolResult {
  const message = cause instanceof Error ? cause.message : "SurfaceLoom service request failed.";
  return { isError: true, content: [{ type: "text", text: message }] };
}

export async function safely(call: () => Promise<Record<string, unknown>> | Record<string, unknown>) {
  try { return toolResult(await call()); } catch (cause) { return toolError(cause); }
}

export function summarizeRun(record: StoredRunRecord): Record<string, unknown> {
  const reason = record.result !== undefined && "reason" in record.result
    ? record.result.reason : undefined;
  return {
    runId: record.runId, requestId: record.requestId, testId: record.testId,
    snapshot: record.snapshot, parameters: record.parameters,
    ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
    ...(record.executionLinks === undefined ? {} : { executionLinks: record.executionLinks }),
    status: record.status, outcome: record.outcome,
    ...(reason === undefined ? {} : { businessReason: reason }),
    artifacts: record.artifacts, createdAt: record.createdAt, updatedAt: record.updatedAt,
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.cleanup === undefined ? {} : { cleanup: record.cleanup }),
    ...(record.workspaceRelease === undefined ? {} : { workspaceRelease: record.workspaceRelease }),
    tainted: record.tainted,
  };
}

export function terminal(status: StoredRunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
    || status === "interrupted";
}
