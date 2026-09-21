import {
  defineCaseV3, defineExecutionPlan,
  type BrowserSurfaceBackendPort, type CaseContextV3,
} from "@surfaceloom/test";

import type {
  RegisteredSurfaceLoomV3Test, SurfaceLoomV3CaseOptions,
} from "../../../src/index.js";

export const v3TestId = "service-test:reference/v3-browser";
export const v3CaseId = "reference.v3.browser";

export interface V3FixtureBehavior {
  readonly failCase?: boolean;
  readonly failCleanup?: boolean;
  readonly waitForCancellation?: boolean;
  readonly onRunStarted?: () => void;
}

export function v3ServiceDefinition() {
  return {
    schemaVersion: 1,
    testId: v3TestId,
    title: "Reporter v3 browser Case",
    description: "Runs one registered SurfaceLoom v3 Case through the service.",
    caseSpecs: [{ id: v3CaseId }],
    coverage: { includes: ["browser-status"], exclusions: [] },
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    runtime: { executorId: "surfaceloom.v3", kind: "surfaceloom-v3" },
    effect: "writesLocal",
    requirements: { platforms: ["darwin", "linux", "win32"],
      capabilities: ["browser.dom.inspect"], environment: [] },
    output: { resultFormat: "surfaceloom.run-result/v1", artifacts: [
      { name: "report.json", mediaType: "application/json", required: true },
      { name: "index.html", mediaType: "text/html", required: true },
      { name: "ai-review.md", mediaType: "text/markdown", required: true },
      { name: "complete.json", mediaType: "application/json", required: true },
    ] },
  } as const;
}

export function v3Registration(behavior: V3FixtureBehavior = {}): RegisteredSurfaceLoomV3Test {
  const spec = {
    id: v3CaseId, locale: "en-US", platforms: ["web"] as const,
    suite: { id: "reference.v3", name: "Reference v3" },
    name: "Browser status", intent: "Verify the browser status through the v3 runner.",
    preconditions: [], acceptanceCriteria: [{ id: "status", text: "Status is ready." }],
    sideEffect: "writesLocal" as const,
  };
  const definition = defineCaseV3({ spec, run: async (context: CaseContextV3) => {
    if (behavior.waitForCancellation) {
      behavior.onRunStarted?.();
      await waitForAbort(context.signal);
      context.acknowledgeCancellation();
      return;
    }
    const surface = context.surface("page");
    if (surface.kind !== "browser") throw new Error("Expected browser surface.");
    await surface.perform({ kind: "readText",
      locator: { kind: "testId", key: "testId", value: "status" } });
    await context.criterion("status", () => {
      if (behavior.failCase) throw new Error("Status was not ready.");
    });
  } });
  const surfaces = { page: { kind: "browser" as const,
    capabilities: ["browser.dom.inspect"] } };
  const plan = defineExecutionPlan({ spec,
    requirements: { host: { os: ["linux"] }, surfaces },
    effects: [
      { resource: "browser.session", operation: "execute", boundary: "local",
        securitySensitive: false, recovery: "unknown" },
      { resource: "browser.readText", operation: "read", boundary: "local",
        securitySensitive: false, recovery: "notNeeded" },
    ] });
  const options: SurfaceLoomV3CaseOptions = {
    platform: "web", runnerHostId: "runner-host",
    run: { title: "Service v3 fixture", app: { id: "fixture", name: "Fixture" },
      hosts: [{ id: "runner-host", os: "linux" }, { id: "browser-host", os: "linux" }] },
    surfaces: [{ kind: "browser", backend: browserBackend(behavior), requirement: {
      kind: "browser", surfaceId: "page", expectedHostId: "browser-host",
      capabilities: ["browser.dom.inspect"], engine: "chromium",
    } }],
    execution: { plan, environment: { platform: "web", host: { os: "linux" }, surfaces },
      policy: { maximumSideEffect: "writesLocal", grants: [
        { resource: "browser.session", operations: ["execute"], boundaries: ["local"],
          allowUnknownRecovery: true },
        { resource: "browser.readText", operations: ["read"], boundaries: ["local"] },
      ] }, timeoutMs: 2_000, cancellationGraceMs: 500, cleanupTimeoutMs: 200 },
  };
  return { testId: v3TestId, caseSpecId: v3CaseId, resolve: () => ({ definition, options }) };
}

function browserBackend(behavior: V3FixtureBehavior): BrowserSurfaceBackendPort {
  return { hostId: "browser-host", capabilities: ["browser.dom.inspect"],
    launch: async (_requirement, call) => {
      call.beforeSubmit();
      return { identity: { hostId: "browser-host", sessionId: "browser-session" },
        invoke: async (_action, operation) => { operation.beforeSubmit(); return "ready"; },
        close: async () => {
          if (behavior.failCleanup) throw new Error("Browser close proof missing.");
          return { kind: "browserSessionClosed", hostId: "browser-host",
            sessionId: "browser-session" };
        } };
    } };
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(),
    { once: true }));
}
