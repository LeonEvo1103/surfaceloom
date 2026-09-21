import { createMcpHandler, McpServer, type McpHttpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AgentTestService } from "../agent-service.js";
import {
  artifactSchema, operationSchema, parametersSchema, runSummarySchema, testDefinitionSchema,
} from "./schemas.js";
import { safely, summarizeRun, terminal } from "./results.js";

const id = z.string().min(1).max(256);
const effect = z.enum(["readOnly", "reversible", "writesLocal", "externalEffect",
  "securitySensitive"]);

export function createSurfaceLoomMcpServer(service: AgentTestService): McpServer {
  const server = new McpServer({ name: "surfaceloom", version: "0.1.0" });

  server.registerTool("catalog", {
    title: "List SurfaceLoom tests",
    description: "List registered tests and their declared parameters, effects, and requirements.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ tests: z.array(testDefinitionSchema) }),
  }, async () => safely(() => ({ tests: service.catalog() as unknown[] })));

  server.registerTool("prepare", {
    title: "Prepare an immutable workspace",
    description: "Prepare a configured source at an exact revision without accepting a filesystem path.",
    inputSchema: z.object({ sourceKey: id, revision: z.string().min(1).max(256) }).strict(),
    outputSchema: z.object({ operationId: id, status: z.literal("preparing") }),
  }, async ({ sourceKey, revision }) => safely(() => ({ ...service.prepare(sourceKey, revision) })));

  server.registerTool("status", {
    title: "Read preparation or run status",
    description: "Read an operation, run, or a run recovered by its caller requestId.",
    inputSchema: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("operation"), operationId: id }).strict(),
      z.object({ kind: z.literal("run"), runId: id }).strict(),
      z.object({ kind: z.literal("request"), requestId: z.string().min(1).max(256) }).strict(),
    ]),
    outputSchema: z.object({ kind: z.enum(["operation", "run", "request"]), found: z.boolean(),
      operation: operationSchema.optional(), run: runSummarySchema.optional() }),
  }, async (input) => safely(async () => {
    if (input.kind === "operation") {
      const operation = service.operation(input.operationId);
      return { kind: input.kind, found: operation !== undefined,
        ...(operation === undefined ? {} : { operation }) };
    }
    const run = input.kind === "run" ? await service.run(input.runId)
      : await service.runByRequestId(input.requestId);
    return { kind: input.kind, found: run !== undefined,
      ...(run === undefined ? {} : { run: summarizeRun(run) }) };
  }));

  server.registerTool("run", {
    title: "Start a registered test",
    description: "Persist and start one registered test. Reuse requestId to recover a lost response.",
    inputSchema: z.object({ requestId: z.string().min(1).max(256), snapshotId: id, testId: id,
      parameters: parametersSchema.optional(), taskId: id.optional(),
      acknowledgedEffect: effect.optional() }).strict(),
    outputSchema: z.object({ runId: id,
      status: z.enum(["queued", "preparing", "running", "cancelling", "completed", "failed",
        "cancelled", "interrupted"]), reused: z.boolean() }),
  }, async (input) => safely(async () => ({ ...await service.start({
    requestId: input.requestId, snapshotId: input.snapshotId, testId: input.testId,
    ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.acknowledgedEffect === undefined ? {}
      : { acknowledgedEffect: input.acknowledgedEffect }),
  }) })));

  server.registerTool("get_result", {
    title: "Get a test result",
    description: "Read the current run summary and terminal result when ready.",
    inputSchema: z.object({ runId: id }).strict(),
    outputSchema: z.object({ found: z.boolean(), ready: z.boolean(), run: runSummarySchema.optional() }),
  }, async ({ runId }) => safely(async () => {
    const run = await service.result(runId);
    return { found: run !== undefined, ready: run !== undefined && terminal(run.status),
      ...(run === undefined ? {} : { run: summarizeRun(run) }) };
  }));

  server.registerTool("get_artifact", {
    title: "Read bounded artifact bytes",
    description: "Read one bounded base64 chunk from an artifact returned by a run.",
    inputSchema: z.object({ artifactId: id, offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(256 * 1024).optional() }).strict(),
    outputSchema: z.object({ found: z.boolean(), artifact: artifactSchema.optional(),
      offset: z.number().int().nonnegative().optional(), dataBase64: z.string().optional(),
      nextOffset: z.number().int().nonnegative().nullable().optional() }),
  }, async ({ artifactId, offset, limit }) => safely(async () => {
    const chunk = await service.artifact(artifactId, offset, limit);
    return chunk === undefined ? { found: false } : { found: true, ...chunk };
  }));

  server.registerTool("cancel", {
    title: "Cancel a test run",
    description: "Explicitly cancel a run; disconnecting the MCP client does not cancel it.",
    inputSchema: z.object({ runId: id, reason: z.string().min(1).max(500) }).strict(),
    outputSchema: z.object({ runId: id,
      disposition: z.enum(["accepted", "already-terminal", "not-found"]) }),
  }, async ({ runId, reason }) => safely(async () => ({ ...await service.cancel(runId, reason) })));

  return server;
}

export function createSurfaceLoomMcpHandler(service: AgentTestService): McpHttpHandler {
  return createMcpHandler(() => createSurfaceLoomMcpServer(service));
}
