import assert from "node:assert/strict";
import test from "node:test";

import { maximumAgentLoopListCases, mergeAgentLoopTraces, renderAgentLoopHTML, renderAgentLoopListHTML, type AgentLoopTrace } from "../src/index.js";

function trace(id: string, startedAt: string, offsetMs: number): AgentLoopTrace {
  return {
    schemaVersion: "surfaceloom.agent-loop/v1",
    id,
    title: id,
    source: "generic",
    startedAt,
    durationMs: offsetMs,
    events: [{ id: "same", offsetMs, lane: "tool", phase: "instant", name: "tool.event", status: "passed" }],
    warnings: [],
  };
}

test("merges absolute clocks and namespaces ids", () => {
  const merged = mergeAgentLoopTraces([
    trace("first", "2026-01-01T00:00:00.000Z", 20),
    trace("second", "2026-01-01T00:00:01.000Z", 10),
  ]);
  assert.deepEqual(merged.events.map((event) => event.id), ["1:same", "2:same"]);
  assert.deepEqual(merged.events.map((event) => event.offsetMs), [20, 1010]);
  assert.equal(merged.durationMs, 1010);
});

test("renders a standalone, script-free and escaped timeline", () => {
  const output = renderAgentLoopHTML(trace("viewer", "2026-01-01T00:00:00Z", 10));
  assert.match(output, /Content-Security-Policy/);
  assert.match(output, /Agent loop timeline/);
  assert.doesNotMatch(output, /<script>/);
  assert.doesNotMatch(output, / style=/);
  assert.match(output, /\.event-0\{left:99\.400%;width:0\.600%\}/);
  assert.doesNotMatch(output, /https?:\/\//);
});

test("falls back to relative offsets when a trace has no absolute clock", () => {
  const withoutClock = { ...trace("relative", "2026-01-01T00:00:00Z", 5), startedAt: undefined } as unknown as AgentLoopTrace;
  const merged = mergeAgentLoopTraces([withoutClock, trace("absolute", "2026-01-01T00:00:02Z", 7)]);
  assert.deepEqual(merged.events.map((event) => event.offsetMs), [5, 7]);
  assert.match(merged.warnings.at(-1) ?? "", /relative offsets/);
});

test("renders multiple traces as a static case list", () => {
  const recovered = {
    ...trace("recovered", "2026-01-01T00:00:00Z", 20),
    events: [
      { id: "failed", offsetMs: 5, lane: "browser", phase: "finish", name: "query", status: "failed" },
      { id: "passed", offsetMs: 20, lane: "agent", phase: "finish", name: "task", status: "passed" },
    ],
  } as AgentLoopTrace;
  const output = renderAgentLoopListHTML([
    recovered,
    trace("second", "2026-01-01T00:00:01Z", 10),
  ], { title: "<Suite>", warnings: ["Skipped /Users/alice/private"] });

  assert.match(output, /2 cases/);
  assert.match(output, /&lt;Suite&gt;/);
  assert.match(output, /History: 1 failed event; final status: passed/);
  assert.match(output, /Show 2 events/);
  assert.match(output, /1 batch warning omitted/);
  assert.doesNotMatch(output, /<script>/);
  assert.doesNotMatch(output, / style=/);
  assert.doesNotMatch(output, /https?:\/\//);
});

test("normalizes direct viewer input without rendering free-form trace text", () => {
  const unsafe = {
    ...trace("viewer", "2026-01-01T00:00:00Z", 10),
    title: "Customer prompt must not render",
    warnings: ["token=not-a-real-token /Users/alice/private"],
    events: [{
      id: "unsafe",
      offsetMs: 10,
      lane: "tool",
      phase: "instant",
      name: "send private prompt to person@example.test",
      status: "passed",
      summary: "private reasoning",
      details: { status: "plain private sentence", prompt: "private prompt", token: "not-a-real-token" },
    }],
  } as AgentLoopTrace;
  const output = `${renderAgentLoopHTML(unsafe)}\n${renderAgentLoopListHTML([unsafe])}`;
  assert.doesNotMatch(output, /Customer prompt|private prompt|private reasoning|person@example|not-a-real-token|\/Users\/alice/);
  assert.match(output, /tool\.event/);
  assert.match(output, /metadata available/);
});

test("rejects an empty agent-loop case list", () => {
  assert.throws(() => renderAgentLoopListHTML([]), /at least one trace/);
  assert.throws(
    () => renderAgentLoopListHTML(Array.from({ length: maximumAgentLoopListCases + 1 }, () => trace("case", "2026-01-01T00:00:00Z", 1))),
    /exceeds 500 cases/,
  );
});

test("samples large case ledgers while preserving failures and collapses a large index", () => {
  const events = Array.from({ length: 80 }, (_, index) => ({
    id: `event-${index}`,
    offsetMs: index,
    lane: "system" as const,
    phase: "instant" as const,
    name: index === 37 ? "critical-failure" : `sample-${index}`,
    status: index === 37 ? "failed" as const : "passed" as const,
  }));
  const large = { ...trace("large", "2026-01-01T00:00:00Z", 79), events } as AgentLoopTrace;
  const output = renderAgentLoopListHTML(Array.from({ length: 13 }, () => large));

  assert.match(output, /Show 50 sampled events · 80 total/);
  assert.match(output, /critical-failure/);
  assert.doesNotMatch(output, /<details class="case-index" open>/);
});

test("preserves the terminal result when rendering more than the importer default event limit", () => {
  const events = Array.from({ length: 10_001 }, (_, index) => ({
    id: `event-${index}`,
    offsetMs: index,
    lane: "system" as const,
    phase: "instant" as const,
    name: `event-${index}`,
    status: index === 10_000 ? "failed" as const : "passed" as const,
  }));
  const output = renderAgentLoopListHTML([{ ...trace("long", "2026-01-01T00:00:00Z", 10_000), events }]);

  assert.match(output, /10001 events/);
  assert.match(output, /History: 1 failed event; final status: failed/);
  assert.match(output, /status-failed/);
});
