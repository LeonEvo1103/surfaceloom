import assert from "node:assert/strict";
import test from "node:test";

import { validateFrameworkSsot } from "../lib/framework-ssot.mjs";

test("accepts a complete acyclic ledger with evidence for done tasks", () => {
  const result = validateFrameworkSsot(document([
    row("SL-P0-001", "done", "—"),
    row("SL-P0-010", "in_progress", "`SL-P0-001`"),
    row("SL-P5-010", "ready", "`SL-P0-010`"),
    row("SL-P6-010", "planned", "`SL-P5-010`"),
  ], [evidence("SL-P0-001")]));
  assert.deepEqual(result.tasks.map((task) => task.id), [
    "SL-P0-001",
    "SL-P0-010",
    "SL-P5-010",
    "SL-P6-010",
  ]);
});

test("rejects duplicate ids, unknown dependencies, cycles, states, and missing evidence", () => {
  const cases = [
    [row("SL-P0-001", "ready", "—"), row("SL-P0-001", "ready", "—")],
    [row("SL-P0-001", "ready", "`SL-P0-999`")],
    [row("SL-P0-001", "ready", "`SL-P0-010`"), row("SL-P0-010", "ready", "`SL-P0-001`")],
    [row("SL-P0-001", "working", "—")],
    [row("SL-P0-001", "done", "—")],
  ];
  for (const rows of cases) assert.throws(() => validateFrameworkSsot(document(rows, [])));
});

test("rejects malformed task ids and dependency references instead of ignoring them", () => {
  const cases = [
    [row("SL-PX-010", "ready", "—")],
    [row("SL-P5-10", "ready", "—")],
    [row("SL-P5-010", "ready", "`SL-PX-001`")],
    [row("SL-P5-010", "ready", "SL-P99-999")],
    [row("SL-P5-010", "ready", "SL-PX-999")],
    [row("SL-P5-010", "ready", "`SL-P5-001")],
    ["| `SL-P5-010 | planned | — | path | result |"],
  ];
  for (const rows of cases) assert.throws(() => validateFrameworkSsot(document(rows, [])), /Malformed SSOT/);
});

test("parses indented task rows instead of silently dropping them", () => {
  const result = validateFrameworkSsot(document([
    `  ${row("SL-P5-010", "ready", "—")}`,
  ], []));
  assert.deepEqual(result.tasks.map((task) => task.id), ["SL-P5-010"]);
});

function row(id, state, dependencies) {
  return `| \`${id}\` | ${state} | ${dependencies} | path | result |`;
}

function evidence(id) {
  return `| \`${id}\` | revision | path | command / 0 | macOS | 1 / 0 | path | none |`;
}

function document(rows, evidenceRows) {
  return [
    "## 8. 原子任务账本",
    ...rows,
    "## 9. 并行施工规则",
    "## 11. 验收记录",
    ...evidenceRows,
    "## 12. 变更记录",
  ].join("\n");
}
