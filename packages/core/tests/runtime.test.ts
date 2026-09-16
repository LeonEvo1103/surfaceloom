import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryTraceRecorder,
  parseDoctorReport,
  resolveActionabilityChecks,
  summarizeDoctor,
} from "../src/index.js";

test("uses action-specific checks and never forces away strict uniqueness", () => {
  assert.deepEqual(resolveActionabilityChecks("invoke"), [
    "attached",
    "unique",
    "visible",
    "enabled",
  ]);
  assert.deepEqual(resolveActionabilityChecks("typeText", { force: true }), [
    "attached",
    "unique",
  ]);
  assert.deepEqual(
    resolveActionabilityChecks("typeText", {
      force: true,
      additionalChecks: ["stable"],
    }),
    ["attached", "unique", "stable"],
  );
  assert.deepEqual(
    resolveActionabilityChecks("invoke", { additionalChecks: ["stable"] }),
    ["attached", "unique", "visible", "enabled", "stable"],
  );
  assert.throws(
    () => resolveActionabilityChecks("invoke", { timeoutMs: Number.NaN }),
    /timeout/,
  );
});

test("records ordered trace events and redacts nested secrets", () => {
  const recorder = new InMemoryTraceRecorder({
    now: () => new Date("2026-08-18T00:00:00.000Z"),
  });
  recorder.record({
    kind: "operation.started",
    operationId: "op-1",
    componentId: "desktop.agent.composer",
    details: {
      locatorStrategy: "identifier",
      authorization: "Bearer private",
      nested: { token: "private", status: "ready" },
      apiKey: "private",
      prompt: "private conversation text",
    },
  });
  recorder.record({
    kind: "operation.finished",
    operationId: "op-1",
    outcome: "passed",
    durationMs: 12,
  });
  recorder.record({
    kind: "diagnostic",
    level: "error",
    message: "request failed with Authorization: private and Bearer abc.def",
  });
  recorder.record({
    kind: "attachment",
    name: "private screenshot",
    contentType: "image/png",
    path: "/Users/private/secret.png",
    sensitive: true,
  });
  recorder.record({
    kind: "diagnostic",
    level: "info",
    message: "private conversation body",
    sensitive: true,
  });

  const events = recorder.snapshot();
  assert.equal(events[0]?.sequence, 1);
  assert.equal(events[1]?.sequence, 2);
  assert.deepEqual("details" in events[0]! ? events[0].details : undefined, {
    locatorStrategy: "identifier",
    authorization: "[REDACTED]",
    nested: { token: "[REDACTED]", status: "ready" },
    apiKey: "[REDACTED]",
    prompt: "[REDACTED]",
  });
  const diagnostic = events[2];
  assert.equal(
    diagnostic?.kind === "diagnostic" ? diagnostic.message : undefined,
    "request failed with Authorization=[REDACTED] and Bearer [REDACTED]",
  );
  const attachment = events[3];
  assert.equal(
    attachment?.kind === "attachment" ? attachment.path : undefined,
    "[REDACTED]",
  );
  const sensitiveDiagnostic = events[4];
  assert.equal(
    sensitiveDiagnostic?.kind === "diagnostic"
      ? sensitiveDiagnostic.message
      : undefined,
    "[REDACTED]",
  );
  assert.equal(Object.isFrozen(events), true);
});

test("doctor blocks only required failures or unsupported requirements", () => {
  const summary = summarizeDoctor({
    schemaVersion: "1",
    platform: "windows",
    generatedAt: "2026-08-18T00:00:00.000Z",
    readOnly: true,
    checks: [
      { id: "uia", summary: "UIA available", status: "pass", required: true },
      { id: "video", summary: "Video unavailable", status: "warn", required: false },
      {
        id: "secure-desktop",
        summary: "Secure Desktop cannot be controlled",
        status: "unsupported",
        required: true,
      },
    ],
  });

  assert.deepEqual(summary, {
    canStartSession: false,
    passed: 1,
    warnings: 1,
    failures: 0,
    unsupported: 1,
  });
});

test("doctor parsing rejects unknown, duplicate, empty, and missing checks", () => {
  const base = {
    schemaVersion: "1",
    platform: "macos",
    generatedAt: "2026-08-18T00:00:00.000Z",
    readOnly: true,
  };
  const validCheck = {
    id: "macos.accessibilityTrust",
    summary: "Runner is trusted",
    status: "pass",
    required: true,
  };

  assert.equal(
    parseDoctorReport(
      { ...base, checks: [validCheck] },
      { expectedCheckIds: ["macos.accessibilityTrust"] },
    ).checks.length,
    1,
  );
  assert.throws(
    () => parseDoctorReport({ ...base, checks: [{ ...validCheck, status: "failure" }] }),
    /Unknown doctor status/,
  );
  assert.throws(
    () =>
      parseDoctorReport({
        ...base,
        checks: [{ ...validCheck, required: undefined }],
      }),
    /check.required must be boolean/,
  );
  assert.throws(
    () => parseDoctorReport({ ...base, readOnly: false, checks: [validCheck] }),
    /readOnly: true/,
  );
  assert.throws(() => parseDoctorReport({ ...base, checks: [] }), /must contain checks/);
  assert.throws(
    () => parseDoctorReport({ ...base, checks: [validCheck, validCheck] }),
    /Duplicate doctor check/,
  );
  assert.throws(
    () =>
      parseDoctorReport(
        { ...base, checks: [validCheck] },
        { expectedCheckIds: ["macos.appBundle"] },
      ),
    /Missing expected doctor check/,
  );
});
