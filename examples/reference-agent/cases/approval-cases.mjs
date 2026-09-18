import { readFileSync } from "node:fs";

import { PlaywrightBrowserBackend } from "@surfaceloom/browser-playwright";
import { defineFixture } from "@surfaceloom/core";
import {
  assertObservation,
  defineCase,
  defineEffect,
  defineExecutionPlan,
  expectAgent,
} from "@surfaceloom/test";
import {
  ReferenceAgentBrowserAdapter,
  referenceAgentLocalResource,
  referenceAgentToolId,
  runBarrier,
} from "../adapter/reference-agent-browser.mjs";
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
      const agent = await browser.bindRun(runId);
      const barrier = runBarrier(runId);
      await approvalCriterion(context, agent, "deny-approval-requested");
      await context.dispatch(approvalDecision, () => browser.decide("deny"));
      await statusCriterion(context, agent, "deny-status", "denied");
      await context.criterion("deny-zero-executions", () => settleAssertions([
        assertNoToolExecution(browser, agent.tool(referenceAgentToolId), barrier),
        assertLocalEffectCount(browser, runId, 0, barrier, "deny-zero-executions"),
      ]));
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
      const agent = await browser.bindRun(runId);
      const barrier = runBarrier(runId);
      await approvalCriterion(context, agent, "approve-approval-requested");
      await context.dispatch(approvalDecision, () => browser.decide("approve"));
      await statusCriterion(context, agent, "approve-status", "completed");
      await context.criterion("approve-one-execution", () =>
        expectAgent(agent.tool(referenceAgentToolId)).toHaveExecutedExactlyOnce({
          barrier, criterionId: "approve-one-execution",
        }));
      await context.criterion("approve-one-effect", () =>
        assertLocalEffectCount(browser, runId, 1, barrier, "approve-one-effect"));
    },
  });
}

/** @returns {import("@surfaceloom/test").ExecuteCaseOptions} */
export function executionOptions(spec) {
  const capabilities = /** @type {const} */ (
    ["browser.navigate", "browser.dom.inspect", "browser.dom.invoke"]
  );
  /** @type {import("@surfaceloom/test").ExecutionEnvironment} */
  const environment = {
    platform: "web",
    host: { os: hostOS() },
    surfaces: { approvalUi: { kind: "browser", capabilities } },
  };
  /** @type {import("@surfaceloom/test").ExecutionEffectPolicy} */
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

async function statusCriterion(context, agent, criterionId, expected) {
  await context.criterion(criterionId, () =>
    expectAgent(agent).toHaveRunState(expected, { criterionId }));
}

async function approvalCriterion(context, agent, criterionId) {
  await context.criterion(criterionId, () =>
    expectAgent(agent).toHaveRequestedApproval({ criterionId }));
}

async function settleAssertions(assertions) {
  const settled = await Promise.allSettled(assertions);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((result) => result.value);
}

function assertNoToolExecution(provider, tool, barrier) {
  return assertObservation(
    (readContext) => provider.readToolCall({ runId: tool.runId, callId: tool.callId }, readContext),
    {
      expectation: {
        kind: "negative-value",
        expected: { runId: tool.runId, callId: tool.callId, requested: 1, started: 0, completed: 0 },
        matches: (value) => value.runId === tool.runId && value.callId === tool.callId
          && value.requested === 1 && value.started === 0 && value.completed === 0,
        completeness: barrier,
      },
      timeoutMs: 300, pollIntervalMs: 25, criterionId: "deny-zero-executions",
    },
  );
}

function assertLocalEffectCount(provider, runId, expectedCount, barrier, criterionId) {
  return assertObservation(
    (readContext) => provider.readLocalEffects(
      { runId, resource: referenceAgentLocalResource }, readContext,
    ),
    {
      expectation: {
        kind: "negative-value",
        expected: {
          runId, resource: referenceAgentLocalResource, boundary: "local", count: expectedCount,
        },
        matches: (value) => value.runId === runId
          && value.resource === referenceAgentLocalResource
          && value.boundary === "local" && value.count === expectedCount,
        completeness: barrier,
      },
      timeoutMs: 1_000, pollIntervalMs: 25, criterionId,
    },
  );
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
