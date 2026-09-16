import assert from "node:assert/strict";
import test from "node:test";

import {
  importAgentLoop,
  importCodexRolloutJSONL,
  importSurfaceLoomTraceJSONL,
  type TraceAdapter,
} from "../src/index.js";
import { buildTrace } from "../src/adapter-sdk.js";

test("imports a Codex rollout without exposing messages, reasoning, paths, or tool arguments", () => {
  const input = [
    { type: "session_meta", timestamp: "2026-01-01T00:00:00.000Z", payload: { cwd: "/Users/alice/private", base_instructions: "secret" } },
    { type: "response_item", timestamp: "2026-01-01T00:00:00.100Z", payload: { type: "message", role: "user", content: [{ text: "do not publish" }] } },
    { type: "response_item", timestamp: "2026-01-01T00:00:00.200Z", payload: { type: "reasoning", summary: ["private chain"] } },
    { type: "response_item", timestamp: "2026-01-01T00:00:00.300Z", payload: { type: "custom_tool_call", call_id: "call-1", name: "shell", input: "token=abc" } },
    { type: "response_item", timestamp: "2026-01-01T00:00:00.500Z", payload: { type: "custom_tool_call_output", call_id: "call-1", output: "private output" } },
  ].map((value) => JSON.stringify(value)).join("\n");
  const trace = importCodexRolloutJSONL(input);
  const serialized = JSON.stringify(trace);

  assert.equal(trace.events.length, 5);
  assert.equal(trace.events[3]?.lane, "tool");
  assert.equal(trace.events[4]?.correlationId, "call-1");
  assert.doesNotMatch(serialized, /do not publish|private chain|private output|token=abc|\/Users\/alice/);
});

test("imports native and browser operations without coupling their backends", () => {
  const input = [
    { sequence: 1, timestamp: "2026-01-01T00:00:00Z", kind: "operation.started", operationId: "a", componentId: "window", action: "raise" },
    { sequence: 2, timestamp: "2026-01-01T00:00:00.010Z", kind: "operation.finished", operationId: "a", componentId: "window", action: "raise", outcome: "passed", durationMs: 10 },
    { sequence: 3, timestamp: "2026-01-01T00:00:00.020Z", kind: "operation.started", operationId: "b", componentId: "browser.dom", action: "click" },
  ].map((value) => JSON.stringify(value)).join("\n");
  const trace = importSurfaceLoomTraceJSONL(input);

  assert.deepEqual(trace.events.map((event) => event.lane), ["desktop", "desktop", "browser"]);
  assert.equal(trace.events[0]?.durationMs, 10);
  assert.equal(trace.events[1]?.durationMs, undefined);
  assert.equal(trace.durationMs, 20);
});

test("auto detection is deterministic and supports third-party adapters", () => {
  const custom: TraceAdapter = {
    id: "custom",
    detect: (input) => input === "custom" ? 100 : 0,
    import: () => ({ schemaVersion: "surfaceloom.agent-loop/v1", id: "custom", title: "Custom", source: "generic", durationMs: 0, events: [], warnings: [] }),
  };
  assert.equal(importAgentLoop("custom", { adapters: [custom] }).id, "custom");
  assert.throws(() => importAgentLoop("custom", { adapters: [custom, custom] }), /ambiguous/);
  assert.throws(() => importAgentLoop("unknown"), /No trace adapter/);
  assert.throws(() => importAgentLoop("custom", { adapters: [{ ...custom, id: "Invalid:Adapter" }] }), /invalid id/);
  assert.throws(() => buildTrace("Invalid:Source", [], [], {}), /source is invalid/);
});

test("applies centralized redaction and limits to third-party adapter output", () => {
  const custom: TraceAdapter = {
    id: "custom",
    detect: () => 100,
    import: () => ({
      schemaVersion: "surfaceloom.agent-loop/v1",
      id: "custom",
      title: "Custom",
      source: "generic",
      durationMs: 9,
      events: [
        { id: "later", offsetMs: 9, lane: "tool", phase: "instant", name: "tool", status: "passed", details: { token: "secret", type: `sk-${"A".repeat(32)}` } },
        { id: "first", offsetMs: 1, lane: "agent", phase: "instant", name: "/Users/alice/task", status: "passed", summary: 'Error data: {"token":"PRIVATE_JSON_TOKEN","password":"PRIVATE_JSON_PASSWORD"}' },
      ],
      warnings: [],
    }),
  };
  const trace = importAgentLoop("custom", { adapters: [custom], maxEvents: 1 });
  assert.equal(trace.events[0]?.id, "first");
  assert.doesNotMatch(JSON.stringify(trace), /\/Users\/alice|"secret"/);
  assert.doesNotMatch(JSON.stringify(trace), /sk-A/);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_JSON_TOKEN|PRIVATE_JSON_PASSWORD/);
  assert.equal(trace.warnings.length, 1);
});

test("limits event count and tolerates a partial final Codex JSONL line", () => {
  const input = `${JSON.stringify({ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: {} })}\n{`;
  const trace = importCodexRolloutJSONL(input, { maxEvents: 1 });
  assert.equal(trace.events.length, 1);
  assert.equal(trace.warnings.length, 1);
});

test("bounds parsing before processing a large valid Codex JSONL trace", () => {
  const line = `${JSON.stringify({ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: {} })}\n`;
  const trace = importCodexRolloutJSONL(line.repeat(130_000), { maxEvents: 1 });
  assert.equal(trace.events.length, 1);
  assert.equal(trace.warnings.some((warning) => /record budget/.test(warning)), true);
  const invalid = importCodexRolloutJSONL("!\n".repeat(250_000), { maxEvents: 1 });
  assert.equal(invalid.warnings.some((warning) => /record budget/.test(warning)), true);
});

test("maps both custom and function-shaped Codex tool calls", () => {
  const input = [
    { type: "response_item", timestamp: "2026-01-01T00:00:00Z", payload: { type: "function_call", call_id: "function-1", name: "read_file", arguments: "private" } },
    { type: "response_item", timestamp: "2026-01-01T00:00:00.010Z", payload: { type: "function_call_output", call_id: "function-1", output: "private" } },
  ].map((value) => JSON.stringify(value)).join("\n");
  const trace = importCodexRolloutJSONL(input);
  assert.deepEqual(trace.events.map((event) => [event.lane, event.phase]), [["tool", "start"], ["tool", "finish"]]);
  assert.doesNotMatch(JSON.stringify(trace), /private/);
});

test("preserves input order for events with the same timestamp", () => {
  const input = Array.from({ length: 12 }, (_, index) => JSON.stringify({
    type: "response_item",
    timestamp: "2026-01-01T00:00:00Z",
    payload: { type: "custom_tool_call", call_id: `call-${index + 1}`, name: "tool" },
  })).join("\n");
  const trace = importCodexRolloutJSONL(input);
  assert.deepEqual(trace.events.map((event) => event.correlationId), Array.from({ length: 12 }, (_, index) => `call-${index + 1}`));
});

test("rejects adapter schema drift and sanitizes cyclic metadata", () => {
  const circular: Record<string, unknown> = { status: "ready" };
  circular.self = circular;
  const custom: TraceAdapter = {
    id: "custom",
    detect: () => 100,
    import: () => ({
      schemaVersion: "surfaceloom.agent-loop/v1",
      id: "custom",
      title: "Custom",
      source: "generic",
      durationMs: 0,
      events: [{ id: "event", offsetMs: 0, lane: "system", phase: "instant", name: "safe", status: "passed", details: circular as never }],
      warnings: [],
    }),
  };
  assert.match(JSON.stringify(importAgentLoop("custom", { adapters: [custom] })), /CIRCULAR/);
  const drifted = { ...custom, import: () => ({ ...custom.import(""), schemaVersion: "future/v9" as never }) };
  assert.throws(() => importAgentLoop("custom", { adapters: [drifted] }), /unsupported schema/);
});
