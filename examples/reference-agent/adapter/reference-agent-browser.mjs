import { defineDomLocator } from "@surfaceloom/browser-playwright";
import { bindAgentRun } from "@surfaceloom/test";
import {
  inspectToolCalls,
  LedgerIncompleteError,
} from "../src/index.mjs";

export const referenceAgentToolId = "append-note";
export const referenceAgentLocalResource = "reference-agent.local-note";

export const referenceAgentLocators = Object.freeze({
  start: defineDomLocator({ key: "run.start", kind: "testId", value: "run.start" }),
  runId: defineDomLocator({ key: "run.id", kind: "testId", value: "run.id" }),
  status: defineDomLocator({ key: "run.status", kind: "testId", value: "run.status" }),
  snapshot: defineDomLocator({ key: "run.snapshot", kind: "testId", value: "run.snapshot" }),
  gate: defineDomLocator({ key: "approval.gate", kind: "testId", value: "approval.gate" }),
  approve: defineDomLocator({
    key: "approval.approve", kind: "role", role: "button", name: "Approve", exact: true,
  }),
  deny: defineDomLocator({
    key: "approval.deny", kind: "role", role: "button", name: "Deny", exact: true,
  }),
});

/** @implements {import("@surfaceloom/test").AgentObservationProvider} */
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
    const { runId } = await this.#waitForRunSnapshot();
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

  async bindRun(runId) {
    assertRunId(runId);
    const observed = await this.#readUiSnapshot(runId);
    if (observed.state !== "available") {
      throw new Error(`Cannot bind reference Agent run: ${observed.reason}`);
    }
    const { callId } = observed.value;
    return bindAgentRun({
      provider: this,
      runId,
      approvalCallId: callId,
      tools: [{ toolId: referenceAgentToolId, callId }],
      assertion: { timeoutMs: 1_000, pollIntervalMs: 25 },
    });
  }

  async readRunState(scope) {
    assertRunId(scope?.runId);
    const observed = await this.#readUiSnapshot(scope.runId);
    if (observed.state !== "available") return observed;
    return Object.freeze({ state: "available",
      value: Object.freeze({ runId: scope.runId, state: observed.value.status }) });
  }

  async readApproval(scope) {
    assertCallScope(scope);
    const observed = await this.#readUiSnapshot(scope.runId, scope.callId);
    if (observed.state !== "available") return observed;
    return Object.freeze({
      state: "available",
      value: Object.freeze({
        runId: scope.runId,
        callId: scope.callId,
        requested: observed.value.approvalRequested,
      }),
    });
  }

  async readToolCall(scope) {
    assertCallScope(scope);
    const ledger = await this.#completedLedger(scope.runId);
    if (ledger.state !== "available") return ledger;
    const phases = ledger.value.events
      .filter((event) => event.callId === scope.callId)
      .map((event) => event.phase);
    return Object.freeze({
      state: "available",
      value: Object.freeze({
        runId: scope.runId,
        callId: scope.callId,
        requested: phases.filter((phase) => phase === "requested").length,
        started: phases.filter((phase) => phase === "started").length,
        completed: phases.filter((phase) => phase === "completed").length,
      }),
      completeness: completeRunBarrier(scope.runId),
    });
  }

  async readExternalEffects(scope) {
    assertResourceScope(scope);
    await this.#readRun(scope.runId);
    return Object.freeze({
      state: "unknown",
      reason: scope.resource === referenceAgentLocalResource
        ? `Resource '${scope.resource}' is local; it cannot establish an external-effect claim.`
        : `Reference agent has no external resource '${scope.resource}'.`,
    });
  }

  async readLocalEffects(scope) {
    assertResourceScope(scope);
    if (scope.resource !== referenceAgentLocalResource) {
      return Object.freeze({
        state: "unknown", reason: `Reference agent has no local resource '${scope.resource}'.`,
      });
    }
    const ledger = await this.#completedLedger(scope.runId);
    if (ledger.state !== "available") return ledger;
    const effects = await this.#getJson(`/api/runs/${encodeURIComponent(scope.runId)}/effects`);
    if (!Array.isArray(effects) || effects.some((effect) => !validEffect(effect, scope.runId))) {
      return Object.freeze({ state: "unknown", reason: "Reference agent returned an invalid effect snapshot." });
    }
    return Object.freeze({
      state: "available",
      value: Object.freeze({
        runId: scope.runId,
        resource: scope.resource,
        boundary: "local",
        count: effects.length,
      }),
      completeness: completeRunBarrier(scope.runId),
    });
  }

  async #readRun(runId) {
    assertRunId(runId);
    const run = await this.#getJson(`/api/runs/${encodeURIComponent(runId)}`);
    if (!run || run.runId !== runId || typeof run.callId !== "string") {
      throw new Error("Reference agent returned a run with mismatched identity.");
    }
    return run;
  }

  async #completedLedger(runId) {
    const ledger = await this.#getJson(`/api/runs/${encodeURIComponent(runId)}/ledger`);
    try {
      inspectToolCalls(ledger, runId);
      return Object.freeze({ state: "available", value: ledger });
    } catch (error) {
      if (!(error instanceof LedgerIncompleteError)) throw error;
      return Object.freeze({ state: "unknown", reason: error.message });
    }
  }

  async #getJson(pathname) {
    const response = await fetch(this.baseUrl + pathname);
    if (!response.ok) throw new Error(`Reference agent probe returned HTTP ${response.status}.`);
    return response.json();
  }

  async #readUiSnapshot(expectedRunId, expectedCallId) {
    const text = await this.session.text(referenceAgentLocators.snapshot, { timeoutMs: 500 });
    const snapshot = parseUiSnapshot(text);
    if (snapshot === null) {
      return Object.freeze({ state: "unknown", reason: "Browser returned a malformed run snapshot." });
    }
    if (snapshot.runId !== expectedRunId
        || (expectedCallId !== undefined && snapshot.callId !== expectedCallId)) {
      return Object.freeze({ state: "unknown", reason: "Browser run snapshot identity does not match the request." });
    }
    return Object.freeze({ state: "available", value: snapshot });
  }

  async #waitForRunSnapshot(timeoutMs = 5_000) {
    const deadline = performance.now() + timeoutMs;
    do {
      const text = await this.session.text(referenceAgentLocators.snapshot,
        { timeoutMs: Math.min(500, timeoutMs) });
      const snapshot = parseUiSnapshot(text);
      if (snapshot !== null) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (performance.now() < deadline);
    throw new Error("Browser did not publish a valid run snapshot before the deadline.");
  }
}

export function runBarrier(runId) {
  assertRunId(runId);
  return Object.freeze({ kind: "barrier", id: `reference-agent.run-ended:${runId}` });
}

function completeRunBarrier(runId) {
  return Object.freeze({ ...runBarrier(runId), complete: true });
}

const runStates = new Set(["awaiting-approval", "executing", "completed", "denied", "cancelled"]);

function parseUiSnapshot(text) {
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
        || Object.keys(value).sort().join(",") !== "approvalRequested,callId,runId,status"
        || typeof value.approvalRequested !== "boolean" || !runStates.has(value.status)) return null;
    assertRunId(value.runId);
    assertCallId(value.runId, value.callId);
    return Object.freeze({ runId: value.runId, callId: value.callId,
      status: value.status, approvalRequested: value.approvalRequested });
  } catch {
    return null;
  }
}

function assertCallScope(scope) {
  assertRunId(scope?.runId);
  assertCallId(scope.runId, scope?.callId);
}

function assertResourceScope(scope) {
  assertRunId(scope?.runId);
  if (typeof scope?.resource !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(scope.resource)) {
    throw new Error("Reference agent requires an exact resource id.");
  }
}

function assertCallId(runId, callId) {
  if (typeof callId !== "string" || !callId.startsWith(`${runId}:call-`)
      || !/^run-\d{6}:call-\d+$/u.test(callId)) {
    throw new Error("Reference agent returned an invalid call id.");
  }
}

function validEffect(effect, runId) {
  return effect && effect.runId === runId && typeof effect.callId === "string"
    && effect.callId.startsWith(`${runId}:call-`) && effect.tool === referenceAgentToolId;
}

function assertRunId(runId) {
  if (typeof runId !== "string" || !/^run-\d{6}$/u.test(runId)) {
    throw new Error("Reference agent returned an invalid run id.");
  }
}
