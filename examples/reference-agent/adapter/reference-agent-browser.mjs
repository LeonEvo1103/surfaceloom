import {
  defineDomLocator,
} from "../../../packages/browser-playwright/dist/index.js";
import {
  inspectToolCalls,
  LedgerIncompleteError,
} from "../src/index.mjs";

export const referenceAgentLocators = Object.freeze({
  start: defineDomLocator({ key: "run.start", kind: "testId", value: "run.start" }),
  runId: defineDomLocator({ key: "run.id", kind: "testId", value: "run.id" }),
  status: defineDomLocator({ key: "run.status", kind: "testId", value: "run.status" }),
  gate: defineDomLocator({ key: "approval.gate", kind: "testId", value: "approval.gate" }),
  approve: defineDomLocator({
    key: "approval.approve", kind: "role", role: "button", name: "Approve", exact: true,
  }),
  deny: defineDomLocator({
    key: "approval.deny", kind: "role", role: "button", name: "Deny", exact: true,
  }),
});

export class ReferenceAgentBrowserAdapter {
  constructor(session, baseUrl) {
    this.session = session;
    this.baseUrl = new URL(baseUrl).origin;
  }

  async openHome() {
    const result = await this.session.navigate(this.baseUrl, { waitUntil: "domcontentloaded" });
    if (result.status !== 200) throw new Error(`Reference agent returned HTTP ${result.status}.`);
  }

  async openRun(runId) {
    assertRunId(runId);
    const url = `${this.baseUrl}/?run=${encodeURIComponent(runId)}`;
    const result = await this.session.navigate(url, { waitUntil: "domcontentloaded" });
    if (result.status !== 200) throw new Error(`Reference agent returned HTTP ${result.status}.`);
    await this.session.waitFor(referenceAgentLocators.gate, "visible", { timeoutMs: 5_000 });
  }

  async startRun() {
    await this.session.click(referenceAgentLocators.start, { timeoutMs: 5_000 });
    const runId = await this.#waitForNonEmptyText(referenceAgentLocators.runId);
    assertRunId(runId);
    await this.session.waitFor(referenceAgentLocators.gate, "visible", { timeoutMs: 5_000 });
    return runId;
  }

  async decide(decision) {
    const locator = decision === "approve" ? referenceAgentLocators.approve
      : decision === "deny" ? referenceAgentLocators.deny
        : undefined;
    if (!locator) throw new Error(`Unsupported approval decision: ${String(decision)}.`);
    await this.session.click(locator, { timeoutMs: 5_000 });
  }

  async statusObservation() {
    return Object.freeze({
      state: "available",
      value: (await this.session.text(referenceAgentLocators.status, { timeoutMs: 2_000 })).trim(),
    });
  }

  async toolCountsObservation(runId) {
    assertRunId(runId);
    const ledger = await this.#getJson(`/api/runs/${encodeURIComponent(runId)}/ledger`);
    try {
      const counts = inspectToolCalls(ledger, runId);
      return Object.freeze({
        state: "available",
        value: Object.freeze({
          requested: counts.requested,
          started: counts.started,
          completed: counts.completed,
        }),
        completeness: completeRunBarrier(runId),
      });
    } catch (error) {
      if (!(error instanceof LedgerIncompleteError)) throw error;
      return Object.freeze({ state: "unknown", reason: error.message });
    }
  }

  async effectCountObservation(runId) {
    const ledgerObservation = await this.toolCountsObservation(runId);
    if (ledgerObservation.state !== "available") return ledgerObservation;
    const effects = await this.#getJson(`/api/runs/${encodeURIComponent(runId)}/effects`);
    if (!Array.isArray(effects)) throw new Error("Reference agent returned an invalid effect snapshot.");
    return Object.freeze({
      state: "available", value: effects.length, completeness: completeRunBarrier(runId),
    });
  }

  async #getJson(pathname) {
    const response = await fetch(this.baseUrl + pathname);
    if (!response.ok) throw new Error(`Reference agent probe returned HTTP ${response.status}.`);
    return response.json();
  }

  async #waitForNonEmptyText(locator, timeoutMs = 5_000) {
    const deadline = performance.now() + timeoutMs;
    do {
      const value = (await this.session.text(locator, { timeoutMs: Math.min(500, timeoutMs) })).trim();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    throw new Error(`DOM target '${locator.key}' did not contain text before the deadline.`);
  }
}

export function runBarrier(runId) {
  assertRunId(runId);
  return Object.freeze({ kind: "barrier", id: `reference-agent.run-ended:${runId}` });
}

function completeRunBarrier(runId) {
  return Object.freeze({ ...runBarrier(runId), complete: true });
}

function assertRunId(runId) {
  if (typeof runId !== "string" || !/^run-\d{6}$/u.test(runId)) {
    throw new Error("Reference agent returned an invalid run id.");
  }
}
