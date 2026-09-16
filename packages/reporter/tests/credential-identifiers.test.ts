import assert from "node:assert/strict";
import test from "node:test";

import type { ReportBundleInput } from "../src/index.js";
import { validateReportInput } from "../src/index.js";

const base: ReportBundleInput = {
  run: {
    id: "run-safe",
    title: "Credential identifier contract",
    platform: "macos",
    startedAt: "2026-08-19T01:00:00.000Z",
    finishedAt: "2026-08-19T01:00:01.000Z",
    app: { id: "fixture.desktop", name: "Fixture" },
  },
  tests: [{
    spec: {
      id: "case-safe",
      locale: "zh-CN",
      platforms: ["macos"],
      suite: { id: "report.security", name: "报告安全" },
      name: "稳定标识不包含凭据",
      intent: "避免凭据进入跨文件关联键和报告路径。",
      preconditions: [],
      acceptanceCriteria: [
        { id: "credentials-rejected", text: "疑似凭据的稳定标识会被拒绝。" },
      ],
      sideEffect: "readOnly",
    },
    result: {
      status: "passed",
      startedAt: "2026-08-19T01:00:00.000Z",
      durationMs: 1,
      steps: [{
        id: "reject-credential-id",
        title: "确认凭据样式的标识会被拒绝",
        status: "passed",
        durationMs: 1,
        criterionIds: ["credentials-rejected"],
      }],
    },
  }],
};

test("rejects high-confidence credentials in stable machine IDs", () => {
  const secrets = [
    `ghp_${"a".repeat(36)}`,
    `ghs_12345_${"j".repeat(20)}.${"k".repeat(20)}`,
    `github_pat_${"b".repeat(30)}`,
    `sk_live_${"c".repeat(24)}`,
    `AKIA${"D".repeat(16)}`,
    `sk-proj-${"e".repeat(24)}`,
  ];

  for (const id of secrets) {
    assert.throws(
      () => validateReportInput({ ...base, run: { ...base.run, id } }),
      /must not contain credential-like data/,
    );
  }
});

test("does not classify public or short lookalikes as credentials", () => {
  for (const id of [`pk_live_${"p".repeat(24)}`, "ghp_demo", "sk-short"]) {
    assert.doesNotThrow(() => validateReportInput({ ...base, run: { ...base.run, id } }));
  }
});
