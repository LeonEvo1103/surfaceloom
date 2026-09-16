import { readFileSync } from "node:fs";

import { defineFixture } from "../../../packages/core/dist/index.js";
import { PlaywrightBrowserBackend } from "../../../packages/browser-playwright/dist/index.js";
import {
  assertObservation,
  defineCase,
  defineEffect,
  defineExecutionPlan,
} from "../../../packages/test/dist/index.js";
import { ReferenceAgentBrowserAdapter, runBarrier } from "../adapter/reference-agent-browser.mjs";
import { startReferenceAgent } from "../src/index.mjs";

export const denySpec = readSpec("deny.case-spec.json");
export const approveSpec = readSpec("approve.case-spec.json");

const browserRead = defineEffect({
  resource: "reference-agent.browser", operation: "read", boundary: "local",
  securitySensitive: false, recovery: "notNeeded",
});
const runControl = defineEffect({
  resource: "reference-agent.run", operation: "execute", boundary: "local",
  securitySensitive: false, recovery: "resettable",
});
const approvalDecision = defineEffect({
  resource: "reference-agent.approval", operation: "execute", boundary: "local",
  securitySensitive: false, recovery: "resettable",
});
const effects = Object.freeze([browserRead, runControl, approvalDecision]);

export function createDenialCase(options) {
  const { appFixture, browserFixture } = fixtures(options.browserLaunchOptions);
  const fault = options.fault ?? "none";
  return defineCase({
    spec: denySpec,
    fixtures: [appFixture, browserFixture],
    run: async (context) => {
      const app = context.fixture(appFixture);
      const browser = context.fixture(browserFixture);
      let runId;
      if (fault === "none") {
        await context.dispatch(browserRead, () => browser.openHome());
        runId = await context.dispatch(runControl, () => browser.startRun());
      } else {
        runId = await context.dispatch(runControl, () => app.createRun({ fault }).runId);
        await context.dispatch(browserRead, () => browser.openRun(runId));
      }
      await context.dispatch(approvalDecision, () => browser.decide("deny"));
      await statusCriterion(context, browser, "deny-status", "denied");
      await context.criterion("deny-zero-executions", () => assertObservation(
        () => browser.toolCountsObservation(runId),
        {
          expectation: {
            kind: "negative-value", expected: { requested: 1, started: 0, completed: 0 },
            matches: (counts) => counts.requested === 1
              && counts.started === 0 && counts.completed === 0,
            completeness: runBarrier(runId),
          },
          timeoutMs: 300, pollIntervalMs: 25, criterionId: "deny-zero-executions",
        },
      ));
    },
  });
}

export function createApprovalCase(options) {
  const { appFixture, browserFixture } = fixtures(options.browserLaunchOptions);
  return defineCase({
    spec: approveSpec,
    fixtures: [appFixture, browserFixture],
    run: async (context) => {
      const browser = context.fixture(browserFixture);
      await context.dispatch(browserRead, () => browser.openHome());
      const runId = await context.dispatch(runControl, () => browser.startRun());
      await context.dispatch(approvalDecision, () => browser.decide("approve"));
      await statusCriterion(context, browser, "approve-status", "completed");
      await context.criterion("approve-one-execution", () => assertObservation(
        () => browser.toolCountsObservation(runId),
        {
          expectation: {
            kind: "value", expected: { requested: 1, started: 1, completed: 1 },
            matches: (counts) => counts.requested === 1
              && counts.started === 1 && counts.completed === 1,
          },
          timeoutMs: 1_000, pollIntervalMs: 25, criterionId: "approve-one-execution",
        },
      ));
      await context.criterion("approve-one-effect", () => assertObservation(
        () => browser.effectCountObservation(runId),
        {
          expectation: { kind: "value", expected: 1, matches: (count) => count === 1 },
          timeoutMs: 1_000, pollIntervalMs: 25, criterionId: "approve-one-effect",
        },
      ));
    },
  });
}

/** @returns {import("../../../packages/test/dist/index.js").ExecuteCaseOptions} */
export function executionOptions(spec) {
  const capabilities = /** @type {const} */ (
    ["browser.navigate", "browser.dom.inspect", "browser.dom.invoke"]
  );
  /** @type {import("../../../packages/test/dist/index.js").ExecutionEnvironment} */
  const environment = {
    platform: "web",
    host: { os: hostOS() },
    surfaces: { approvalUi: { kind: "browser", capabilities } },
  };
  /** @type {import("../../../packages/test/dist/index.js").ExecutionEffectPolicy} */
  const policy = {
    maximumSideEffect: "reversible",
    grants: effects.map((effect) => ({
      resource: effect.resource,
      operations: [effect.operation],
      boundaries: [effect.boundary],
    })),
  };
  return Object.freeze({
    platform: "web",
    timeoutMs: 15_000,
    plan: defineExecutionPlan({
      spec,
      requirements: { surfaces: { approvalUi: { kind: "browser", capabilities } } },
      effects,
    }),
    environment,
    policy,
  });
}

function fixtures(browserLaunchOptions) {
  const appFixture = defineFixture({
    id: "reference-agent.http",
    setup: async () => {
      const app = await startReferenceAgent();
      return { value: app, teardown: () => app.close() };
    },
  });
  const browserFixture = defineFixture({
    id: "reference-agent.browser",
    dependencies: [appFixture],
    setup: async (context) => {
      const app = context.get(appFixture);
      const session = await new PlaywrightBrowserBackend().launch(browserLaunchOptions);
      return {
        value: new ReferenceAgentBrowserAdapter(session, app.baseUrl),
        teardown: () => session.close(),
      };
    },
  });
  return { appFixture, browserFixture };
}

async function statusCriterion(context, browser, criterionId, expected) {
  await context.criterion(criterionId, () => assertObservation(
    () => browser.statusObservation(),
    {
      expectation: { kind: "value", expected, matches: (status) => status === expected },
      timeoutMs: 1_000, pollIntervalMs: 25, criterionId,
    },
  ));
}

function readSpec(fileName) {
  return Object.freeze(JSON.parse(readFileSync(new URL(fileName, import.meta.url), "utf8")));
}

/** @returns {"macos" | "windows" | "linux"} */
function hostOS() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}
