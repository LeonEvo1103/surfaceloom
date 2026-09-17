import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeReportV3Input,
  validateReportV3Input,
} from "../../src/v3/index.js";
import { v3Input } from "./fixtures.js";

test("represents runner host separately from each surface host", () => {
  const input = v3Input();
  assert.doesNotThrow(() => validateReportV3Input(input));
  const surfaces = input.run.surfaces;
  assert.equal(surfaces.state, "known");
  if (surfaces.state === "known") {
    assert.deepEqual(surfaces.value.map((surface) => [surface.id,
      surface.hostId.state === "known" ? surface.hostId.value : "unknown"]), [
      ["native", "runner"], ["page", "remote-browser"],
    ]);
  }
  const attempts = input.tests[0]!.attempts;
  assert.equal(attempts.state, "known");
  if (attempts.state === "known") {
    assert.equal(attempts.items[0]!.runnerHostId.state, "known");
    assert.deepEqual(attempts.items[0]!.surfaceIds, {
      state: "known", value: ["native", "page"],
    });
  }
});

test("rejects an unknown final attempt and the ambiguous old hostId field", () => {
  const input = v3Input("attempt-missing");
  assert.throws(() => validateReportV3Input(input), /finalAttemptId references an unknown attempt/);
  const valid = v3Input();
  const attempt = (valid.tests[0]!.attempts as { items: unknown[] }).items[0] as Record<string, unknown>;
  const { runnerHostId, ...withoutRunnerHost } = attempt;
  (valid.tests[0]!.attempts as { items: unknown[] }).items[0] = {
    ...withoutRunnerHost, hostId: runnerHostId,
  };
  assert.throws(() => validateReportV3Input(valid), /contains an unknown field/);
});

test("sanitization sorts catalogs, capabilities, surfaces, and attempts deterministically", () => {
  const input = v3Input();
  const safe = sanitizeReportV3Input(input);
  assert.deepEqual(safe.run.hosts.state === "known"
    ? safe.run.hosts.value.map((host) => host.id) : [], ["remote-browser", "runner"]);
  assert.deepEqual(safe.run.surfaces.state === "known"
    ? safe.run.surfaces.value.map((surface) => surface.id) : [], ["native", "page"]);
  const page = safe.run.surfaces.state === "known" ? safe.run.surfaces.value[1] : undefined;
  assert.deepEqual(page?.capabilities, ["browser.dom.inspect", "browser.navigation"]);
  const attempts = safe.tests[0]!.attempts;
  assert.deepEqual(attempts.state === "known"
    ? attempts.items.map((attempt) => attempt.id) : [], ["attempt-1", "attempt-2"]);
  assert.deepEqual(attempts.state === "known" && attempts.items[0]!.surfaceIds.state === "known"
    ? attempts.items[0]!.surfaceIds.value : [], ["native", "page"]);
});

test("sanitization redacts human-authored v3 context and attempt result text", () => {
  const secret = "token=private-value /Users/alice/private.txt";
  const input = v3Input();
  const attempts = input.tests[0]!.attempts;
  assert.equal(attempts.state, "known");
  if (attempts.state !== "known") return;
  const tainted = {
    ...input,
    run: {
      ...input.run,
      title: `Run ${secret}`,
      app: { ...input.run.app, name: `App ${secret}` },
      hosts: input.run.hosts.state === "known" ? { state: "known" as const,
        value: input.run.hosts.value.map((host) => ({ ...host, name: secret })) } : input.run.hosts,
      surfaces: input.run.surfaces.state === "known" ? { state: "known" as const,
        value: input.run.surfaces.value.map((surface) => ({ ...surface, name: secret })) } : input.run.surfaces,
    },
    tests: [{
      ...input.tests[0]!,
      attempts: {
        ...attempts,
        items: attempts.items.map((attempt) => ({ ...attempt, result: {
          ...attempt.result,
          steps: attempt.result.steps.map((step) => ({ ...step, title: secret })),
          ...(attempt.result.error === undefined ? {} : {
            error: { ...attempt.result.error, message: secret },
          }),
        } })),
      },
    }],
  };
  const serialized = JSON.stringify(sanitizeReportV3Input(tainted));
  assert.doesNotMatch(serialized, /private-value|\/Users\/alice/);
  assert.match(serialized, /\[REDACTED\]|\$USER_HOME/);
});

test("rejects known attempt references when the corresponding catalog is unknown", () => {
  const input = v3Input();
  const invalid = { ...input, run: { ...input.run,
    hosts: { state: "unknown" as const, reason: "unavailable" as const },
  } };
  assert.throws(() => validateReportV3Input(invalid), /known .*host id requires a known catalog/);
});

test("requires execution platforms to be non-empty, unique, and declared by the Case", () => {
  for (const executionPlatforms of [[], ["web", "web"], ["windows"]]) {
    const input = v3Input();
    const attempts = input.tests[0]!.attempts;
    assert.equal(attempts.state, "known");
    if (attempts.state !== "known") continue;
    (attempts.items[0] as { executionPlatforms: string[] }).executionPlatforms = executionPlatforms;
    assert.throws(() => validateReportV3Input(input), /execution platform|undeclared/);
  }
});

test("rejects accessors before sanitization can observe a different value", () => {
  const input = v3Input();
  let reads = 0;
  Object.defineProperty(input.run, "id", {
    enumerable: true,
    get() {
      reads += 1;
      return reads < 2 ? "safe-run" : "/Users/alice/AWS_SECRET_ACCESS_KEY=LEAK";
    },
  });
  assert.throws(() => sanitizeReportV3Input(input), /enumerable data field/);
  assert.equal(reads, 0);
});
