import { z } from "zod";

const identity = z.string().min(1).max(256);
const timestamp = z.iso.datetime();
const jsonPrimitive = z.union([z.string(), z.number(), z.boolean()]);
export const parametersSchema = z.record(z.string(), jsonPrimitive);

const parameterDefinition = z.object({
  type: z.enum(["string", "number", "integer", "boolean"]),
  description: z.string(),
  default: jsonPrimitive.optional(),
  enum: z.array(jsonPrimitive).optional(),
});

export const testDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  testId: identity,
  title: z.string(),
  description: z.string(),
  caseSpecs: z.array(z.object({ id: z.string(), source: z.string().optional() })),
  coverage: z.object({ includes: z.array(z.string()),
    exclusions: z.array(z.object({ target: z.string(), reason: z.string() })) }),
  parameters: z.object({ type: z.literal("object"),
    properties: z.record(z.string(), parameterDefinition), required: z.array(z.string()),
    additionalProperties: z.literal(false) }),
  runtime: z.object({ executorId: z.string(), kind: z.enum(["node", "cli", "surfaceloom-v3"]) }),
  effect: z.enum(["readOnly", "reversible", "writesLocal", "externalEffect", "securitySensitive"]),
  requirements: z.object({ platforms: z.array(z.enum(["darwin", "linux", "win32"])),
    capabilities: z.array(z.string()), environment: z.array(z.string()) }),
  output: z.object({ resultFormat: z.literal("surfaceloom.run-result/v1"),
    artifacts: z.array(z.object({ name: z.string(), mediaType: z.string(), required: z.boolean() })) }),
});

export const cleanupSchema = z.object({
  runId: identity.optional(),
  snapshotId: identity,
  status: z.enum(["confirmed", "unconfirmed", "not-required"]),
  tainted: z.boolean(),
  attemptedAt: timestamp,
  detail: z.string().optional(),
});

export const artifactSchema = z.object({
  artifactId: identity, runId: identity, name: z.string(), mediaType: z.string(),
  sizeBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const runSummarySchema = z.object({
  runId: identity,
  requestId: z.string(),
  testId: identity,
  snapshot: z.object({ snapshotId: identity, resolvedRevision: z.string() }),
  parameters: parametersSchema,
  taskId: identity.optional(),
  status: z.enum(["queued", "preparing", "running", "cancelling", "completed", "failed",
    "cancelled", "interrupted"]),
  outcome: z.enum(["passed", "failed", "skipped", "unsupported", "unknown"]).nullable(),
  businessReason: z.string().optional(),
  artifacts: z.array(artifactSchema),
  createdAt: timestamp,
  updatedAt: timestamp,
  startedAt: timestamp.optional(),
  finishedAt: timestamp.optional(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
  cleanup: cleanupSchema.optional(),
  workspaceRelease: cleanupSchema.optional(),
  tainted: z.boolean(),
});

export const operationSchema = z.object({
  operationId: identity,
  status: z.enum(["preparing", "ready", "failed"]),
  requestedRevision: z.string(),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  snapshotId: identity.optional(),
  resolvedRevision: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
