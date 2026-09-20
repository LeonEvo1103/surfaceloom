import { FixtureError, requireObject, requireOnlyKeys } from "./errors.mjs";

export const ACCOUNT_EMAILS = Object.freeze({
  new: "new.user@login.fixture.test",
  existing: "existing.user@login.fixture.test",
});
export const ENTRY_POINTS = Object.freeze(["welcome", "account-menu"]);
export const TEST_CAPTCHA = Object.freeze({ mode: "test", token: "fixture-pass" });
const DEFAULT_FAULTS = Object.freeze({
  misrouteExistingToRegistration: false,
  omitVerificationEmail: false,
});

const copy = (value) => structuredClone(value);
const id = (prefix, value) => `${prefix}-${String(value).padStart(6, "0")}`;

function normalizeFaults(value = {}, { partial = false } = {}) {
  requireObject(value, "faults");
  requireOnlyKeys(value, Object.keys(DEFAULT_FAULTS));
  const faults = partial ? {} : { ...DEFAULT_FAULTS };
  for (const [key, setting] of Object.entries(value)) {
    if (typeof setting !== "boolean") {
      throw new FixtureError("INVALID_INPUT", `faults.${key} must be boolean`);
    }
    faults[key] = setting;
  }
  return faults;
}

function observation(attempt) {
  const terminal = ["authenticated", "reset", "cancelled"].includes(attempt.status);
  return copy({
    schemaVersion: "login-observation/1",
    identity: { runId: attempt.runId, attemptId: attempt.attemptId },
    input: { accountType: attempt.accountType, email: attempt.email },
    ui: {
      entryPoint: attempt.entryPoint,
      displayedScreen: attempt.ui.screen,
      displayedStatus: attempt.ui.status,
    },
    backend: {
      flow: attempt.flow,
      stage: attempt.status,
      emailDeliveryCount: attempt.mailbox.length,
      sessionCreated: attempt.session !== null,
      effects: attempt.effects,
    },
    completeness: { ui: true, backend: true, mailbox: true, settled: terminal },
  });
}

export function createLoginEngine() {
  const runs = new Map();
  let nextRun = 1;
  let nextVerificationCode = 1;
  let closed = false;

  const writable = () => {
    if (closed) throw new FixtureError("FIXTURE_CLOSED", "Fixture is closed", 410);
  };
  const runFor = (runId) => {
    const run = runs.get(runId);
    if (!run) throw new FixtureError("RUN_NOT_FOUND", "Run not found", 404);
    return run;
  };
  const attemptFor = (runId, attemptId) => {
    const attempt = runFor(runId).attempts.get(attemptId);
    if (!attempt) throw new FixtureError("ATTEMPT_NOT_FOUND", "Attempt not found", 404);
    return attempt;
  };

  function createRun(input = {}) {
    writable();
    requireObject(input);
    requireOnlyKeys(input, ["faults"]);
    const runId = id("run", nextRun++);
    const run = {
      runId,
      faults: normalizeFaults(input.faults),
      attempts: new Map(),
      nextAttempt: 1,
      resetGeneration: 0,
    };
    runs.set(runId, run);
    return getRun(runId);
  }

  function getRun(runId) {
    const run = runFor(runId);
    return copy({
      runId: run.runId,
      faults: run.faults,
      resetGeneration: run.resetGeneration,
      attemptIds: [...run.attempts.keys()],
    });
  }

  function setFaults(runId, input) {
    writable();
    const run = runFor(runId);
    run.faults = { ...run.faults, ...normalizeFaults(input, { partial: true }) };
    return getRun(runId);
  }

  function createAttempt(runId, input) {
    writable();
    const run = runFor(runId);
    requireObject(input);
    requireOnlyKeys(input, ["entryPoint", "accountType", "email"]);
    if (typeof input.entryPoint !== "string" || !ENTRY_POINTS.includes(input.entryPoint)) {
      throw new FixtureError("INVALID_ENTRY_POINT", "Unknown login entry point");
    }
    if (typeof input.accountType !== "string" || !Object.hasOwn(ACCOUNT_EMAILS, input.accountType)) {
      throw new FixtureError("INVALID_ACCOUNT_TYPE", "accountType must be new or existing");
    }
    if (typeof input.email !== "string" || input.email !== ACCOUNT_EMAILS[input.accountType]) {
      throw new FixtureError("INVALID_LOCAL_EMAIL", "Use the fixture-local email for this account type");
    }
    const ordinal = run.nextAttempt++;
    const attemptId = `${runId}-attempt-${String(ordinal).padStart(6, "0")}`;
    const attempt = {
      runId, attemptId, ordinal,
      entryPoint: input.entryPoint,
      accountType: input.accountType,
      email: input.email,
      faults: { ...run.faults },
      status: "awaiting-test-captcha",
      flow: null,
      code: String(700000 + nextVerificationCode++),
      mailbox: [],
      session: null,
      ui: { screen: "test-captcha", status: "Test-mode challenge required" },
      effects: [{ type: "attempt.created" }],
    };
    run.attempts.set(attemptId, attempt);
    return observation(attempt);
  }

  function completeCaptcha(runId, attemptId, input) {
    writable();
    const attempt = attemptFor(runId, attemptId);
    requireObject(input);
    requireOnlyKeys(input, ["mode", "token"]);
    if (attempt.status !== "awaiting-test-captcha") {
      throw new FixtureError("INVALID_ATTEMPT_STATE", "Attempt is not awaiting CAPTCHA", 409);
    }
    if (input.mode !== TEST_CAPTCHA.mode || input.token !== TEST_CAPTCHA.token) {
      throw new FixtureError("CAPTCHA_REJECTED", "Explicit fixture test mode and token are required", 403);
    }
    const misrouted = attempt.accountType === "existing"
      && attempt.faults.misrouteExistingToRegistration;
    attempt.flow = attempt.accountType === "new" || misrouted ? "registration" : "sign-in";
    attempt.status = "awaiting-verification-code";
    attempt.ui = {
      screen: attempt.flow === "registration" ? "registration-code" : "sign-in-code",
      status: "Verification code sent",
    };
    attempt.effects.push({ type: "flow.selected", flow: attempt.flow });
    if (!attempt.faults.omitVerificationEmail) {
      const messageId = `${attemptId}-mail-000001`;
      attempt.mailbox.push({
        messageId, to: attempt.email, kind: "verification-code",
        subject: "Local login verification", code: attempt.code,
      });
      attempt.effects.push({ type: "email.delivered", messageId });
    }
    return observation(attempt);
  }

  function verifyCode(runId, attemptId, input) {
    writable();
    const attempt = attemptFor(runId, attemptId);
    requireObject(input);
    requireOnlyKeys(input, ["code"]);
    if (attempt.status !== "awaiting-verification-code") {
      throw new FixtureError("INVALID_ATTEMPT_STATE", "Attempt is not awaiting a code", 409);
    }
    if (typeof input.code !== "string" || input.code !== attempt.code) {
      throw new FixtureError("INVALID_VERIFICATION_CODE", "Verification code is invalid", 401);
    }
    attempt.status = "authenticated";
    attempt.session = {
      sessionId: `${attemptId}-session-000001`,
      runId, attemptId, accountType: attempt.accountType, flow: attempt.flow,
    };
    attempt.code = null;
    attempt.ui = { screen: "account-home", status: "Authenticated" };
    attempt.effects.push({ type: "session.created", sessionId: attempt.session.sessionId });
    return observation(attempt);
  }

  function getMailbox(runId, attemptId) {
    const attempt = attemptFor(runId, attemptId);
    return copy({
      schemaVersion: "login-mailbox/1", runId, attemptId,
      complete: true, messages: attempt.mailbox,
    });
  }

  function getSession(runId, attemptId) {
    const session = attemptFor(runId, attemptId).session;
    if (!session) throw new FixtureError("SESSION_NOT_FOUND", "Session not found", 404);
    return copy(session);
  }

  function resetRun(runId) {
    writable();
    const run = runFor(runId);
    const removedAttemptIds = [...run.attempts.keys()];
    for (const attempt of run.attempts.values()) {
      attempt.code = null;
      attempt.mailbox.length = 0;
      attempt.session = null;
      attempt.status = "reset";
    }
    run.attempts.clear();
    run.faults = { ...DEFAULT_FAULTS };
    run.resetGeneration += 1;
    return copy({ runId, resetGeneration: run.resetGeneration, removedAttemptIds });
  }

  function close() {
    if (closed) return { closed: true };
    closed = true;
    for (const run of runs.values()) {
      for (const attempt of run.attempts.values()) {
        if (attempt.status !== "authenticated") attempt.status = "cancelled";
        attempt.code = null;
        attempt.mailbox.length = 0;
        attempt.session = null;
        attempt.ui = { screen: "closed", status: "Fixture closed" };
      }
    }
    return { closed: true };
  }

  return Object.freeze({
    createRun, getRun, setFaults, createAttempt, completeCaptcha, verifyCode,
    getObservation: (runId, attemptId) => observation(attemptFor(runId, attemptId)),
    getMailbox, getSession, resetRun, close,
  });
}
