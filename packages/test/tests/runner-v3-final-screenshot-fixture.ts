import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type test from "node:test";

import type { CaseSpec } from "@surfaceloom/core";
import type { EvidencePolicy } from "@surfaceloom/reporter";

import { defineCaseV3 } from "../src/definition-v3.js";
import { defineExecutionPlan } from "../src/plan.js";
import { runCaseV3 } from "../src/runner-v3.js";
import type { CaseContextV3, RunCaseV3Options, RunCaseV3Result } from "../src/runner-v3-contracts.js";
import type { BrowserSurfaceBackendPort, BrowserSurfaceSessionPort } from "../src/surfaces/contracts.js";

export const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export const artifactId = "surfaceloom.screenshot.page";
export type Capture = BrowserSurfaceSessionPort["captureScreenshot"] | "omit";
export type CaseBody = (context: CaseContextV3) => Promise<void>;

export interface RunInput {
  readonly body: "pass" | "fail" | "hangUntilAbort" | "skipCriterion" | CaseBody;
  readonly capture?: Capture;
  readonly policy?: Partial<EvidencePolicy>;
  readonly cleanupTimeoutMs?: number;
  readonly timeoutMs?: number;
  /** Browser surfaces in acquisition order; events are tagged with the surface id when >1. */
  readonly surfaceIds?: readonly string[];
}

export async function run(context: test.TestContext, input: RunInput) {
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-v3-final-shot-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const events: string[] = [];
  const surfaceIds = input.surfaceIds ?? ["page"];
  const spec = caseSpec(`runner.v3.final-shot.${path.basename(root).replace(/[^A-Za-z0-9]/gu, "")}`);
  const definition = defineCaseV3({ spec, run: async (caseContext: CaseContextV3) => {
    for (const surfaceId of surfaceIds) caseContext.surface(surfaceId);
    if (typeof input.body === "function") return input.body(caseContext);
    if (input.body === "hangUntilAbort") {
      await new Promise<void>((_resolve, reject) => caseContext.signal.addEventListener("abort",
        () => reject(caseContext.signal.reason)));
    }
    if (input.body === "skipCriterion") return;
    await caseContext.criterion("verified", () => {
      if (input.body === "fail") throw new Error("business assertion failed");
    });
  } });
  const tag = surfaceIds.length > 1;
  const backends = surfaceIds.map((surfaceId) =>
    backend(events, input.capture, surfaceId, tag));
  const result = await runCaseV3(definition, options(root, spec, backends, surfaceIds, input));
  return { result, events };
}

function backend(events: string[], capture: Capture | undefined, surfaceId: string,
  tag: boolean): BrowserSurfaceBackendPort {
  const push = (event: string) => events.push(tag ? `${event}:${surfaceId}` : event);
  const hostId = "browser-host";
  return { hostId, capabilities: ["browser.dom.inspect"],
    launch: async (_requirement, call) => {
      call.beforeSubmit();
      push("launch");
      const session: BrowserSurfaceSessionPort = {
        identity: { hostId, sessionId: `session-${surfaceId}` },
        invoke: async (_action, operation) => { operation.beforeSubmit(); return null; },
        close: async () => {
          push("close");
          return { kind: "browserSessionClosed", hostId, sessionId: `session-${surfaceId}` };
        },
      };
      if (capture === "omit") return session;
      return { ...session, captureScreenshot: async (screenshotCall) => {
        const value = await (capture ?? (async () => ({ mediaType: "image/png" as const,
          bytes: png })))(screenshotCall);
        push("screenshot");
        return value;
      } };
    } };
}

function options(root: string, spec: CaseSpec, browsers: readonly BrowserSurfaceBackendPort[],
  surfaceIds: readonly string[], input: RunInput): RunCaseV3Options {
  const surfaces = Object.fromEntries(surfaceIds.map((surfaceId) =>
    [surfaceId, { kind: "browser" as const, capabilities: ["browser.dom.inspect" as const] }]));
  return {
    platform: "web", runnerHostId: "runner-host",
    run: { id: `run-${spec.id}`, title: "Final screenshot", app: { id: "app", name: "App" },
      hosts: [{ id: "runner-host", os: "linux" }, { id: "browser-host", os: "linux" }] },
    surfaces: surfaceIds.map((surfaceId, index) => ({ kind: "browser" as const,
      backend: browsers[index]!, requirement: { kind: "browser" as const, surfaceId,
        expectedHostId: "browser-host", capabilities: ["browser.dom.inspect"],
        engine: "chromium" as const } })),
    ...(input.policy === undefined ? {} : { evidencePolicy: input.policy }),
    execution: {
      plan: defineExecutionPlan({ spec, requirements: { surfaces }, effects: [{
        resource: "browser.session", operation: "execute", boundary: "local",
        securitySensitive: false, recovery: "unknown" }] }),
      environment: { platform: "web", host: { os: "linux" }, surfaces },
      policy: { maximumSideEffect: "writesLocal", grants: [{ resource: "browser.session",
        operations: ["execute"], boundaries: ["local"], allowUnknownRecovery: true }] },
      timeoutMs: input.timeoutMs ?? 5_000,
      cancellationGraceMs: 200,
      cleanupTimeoutMs: input.cleanupTimeoutMs ?? 1_000,
    },
    stagingDirectory: path.join(root, "staging"),
    outputDirectory: path.join(root, "report"),
  };
}

export function finalAttempt(result: RunCaseV3Result) {
  const attempts = result.bundle.report.tests[0]!.attempts;
  if (attempts.state !== "known") throw new Error("Expected known attempts.");
  return attempts.items.at(-1)!.result;
}

function caseSpec(id: string): CaseSpec {
  return { id, locale: "en-US", platforms: ["web"], suite: { id: "runner.v3", name: "Runner v3" },
    name: "Final screenshot", intent: "Prove runner-owned final browser screenshots.",
    preconditions: [], acceptanceCriteria: [{ id: "verified", text: "The observation is verified." }],
    sideEffect: "writesLocal" };
}
