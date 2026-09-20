import { ACCOUNT_EMAILS, TEST_CAPTCHA } from "./engine.mjs";

const script = String.raw`
const q = (id) => document.querySelector('[data-testid="' + id + '"]');
const entryPoint = document.body.dataset.entryPoint;
let runId = new URL(location.href).searchParams.get('run');
let attemptId = null;
let generation = 0;
async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error.code + ': ' + value.error.message);
  return value;
}
function identityOf(value) {
  return value.identity ?? {runId: value.runId, attemptId: value.attemptId};
}
function requireIdentity(value, expectedRunId, expectedAttemptId) {
  const identity = identityOf(value);
  if (identity.runId !== expectedRunId
      || (expectedAttemptId !== undefined && identity.attemptId !== expectedAttemptId)) {
    throw new Error('IDENTITY_MISMATCH: response does not belong to the active attempt');
  }
  if (typeof identity.attemptId !== 'string' || identity.attemptId.length === 0) {
    throw new Error('IDENTITY_MISMATCH: response has no attempt identity');
  }
  return identity;
}
function isCurrent(token, expectedRunId, expectedAttemptId) {
  return token === generation && runId === expectedRunId && attemptId === expectedAttemptId;
}
function clearAttemptUi() {
  q('attempt.id').textContent = '';
  q('mailbox.count').textContent = '0';
  q('code.input').value = '';
  q('session.id').textContent = '';
  q('observation.json').textContent = '{}';
  q('login.error').textContent = '';
  q('login.screen').textContent = 'starting';
  q('login.status').textContent = 'Starting login attempt';
  q('captcha.panel').hidden = true;
  q('code.panel').hidden = true;
  q('session.panel').hidden = true;
}
function showObservation(value) {
  q('observation.json').textContent = JSON.stringify(value);
  q('login.screen').textContent = value.ui.displayedScreen;
  q('login.status').textContent = value.ui.displayedStatus;
  q('captcha.panel').hidden = value.backend.stage !== 'awaiting-test-captcha';
  q('code.panel').hidden = value.backend.stage !== 'awaiting-verification-code';
  q('session.panel').hidden = value.backend.stage !== 'authenticated';
}
for (const accountType of ['new', 'existing']) {
  q('account.' + accountType).addEventListener('click', async () => {
    const token = ++generation;
    clearAttemptUi();
    try {
      let selectedRunId = runId;
      if (!selectedRunId) {
        const created = await request('/api/runs', {});
        if (token !== generation) return;
        if (typeof created.runId !== 'string' || created.runId.length === 0) {
          throw new Error('IDENTITY_MISMATCH: response has no run identity');
        }
        selectedRunId = created.runId;
      }
      const value = await request('/api/runs/' + selectedRunId + '/attempts', {
        entryPoint, accountType, email: q('email.' + accountType).textContent,
      });
      const identity = requireIdentity(value, selectedRunId);
      if (token !== generation) return;
      runId = selectedRunId;
      attemptId = identity.attemptId;
      q('run.id').textContent = selectedRunId;
      q('attempt.id').textContent = attemptId;
      history.replaceState(null, '', '?run=' + encodeURIComponent(runId));
      showObservation(value);
    } catch (error) {
      if (token === generation) q('login.error').textContent = error.message;
    }
  });
}
q('captcha.complete').addEventListener('click', async () => {
  const token = generation;
  const expectedRunId = runId;
  const expectedAttemptId = attemptId;
  q('login.error').textContent = '';
  try {
    const value = await request('/api/runs/' + expectedRunId + '/attempts/'
      + expectedAttemptId + '/captcha',
      {mode: q('captcha.mode').textContent, token: q('captcha.token').textContent});
    requireIdentity(value, expectedRunId, expectedAttemptId);
    if (isCurrent(token, expectedRunId, expectedAttemptId)) showObservation(value);
  } catch (error) {
    if (isCurrent(token, expectedRunId, expectedAttemptId)) q('login.error').textContent = error.message;
  }
});
q('mailbox.refresh').addEventListener('click', async () => {
  const token = generation;
  const expectedRunId = runId;
  const expectedAttemptId = attemptId;
  q('login.error').textContent = '';
  try {
    const mailbox = await request('/api/runs/' + expectedRunId + '/attempts/'
      + expectedAttemptId + '/mailbox');
    requireIdentity(mailbox, expectedRunId, expectedAttemptId);
    if (!isCurrent(token, expectedRunId, expectedAttemptId)) return;
    q('mailbox.count').textContent = String(mailbox.messages.length);
    q('code.input').value = mailbox.messages[0]?.code ?? '';
  } catch (error) {
    if (isCurrent(token, expectedRunId, expectedAttemptId)) q('login.error').textContent = error.message;
  }
});
q('code.submit').addEventListener('click', async () => {
  const token = generation;
  const expectedRunId = runId;
  const expectedAttemptId = attemptId;
  q('login.error').textContent = '';
  try {
    const value = await request('/api/runs/' + expectedRunId + '/attempts/'
      + expectedAttemptId + '/verify', {code: q('code.input').value});
    requireIdentity(value, expectedRunId, expectedAttemptId);
    if (!isCurrent(token, expectedRunId, expectedAttemptId)) return;
    const session = await request('/api/runs/' + expectedRunId + '/attempts/'
      + expectedAttemptId + '/session');
    requireIdentity(session, expectedRunId, expectedAttemptId);
    if (!isCurrent(token, expectedRunId, expectedAttemptId)) return;
    q('session.id').textContent = session.sessionId;
    showObservation(value);
  } catch (error) {
    if (isCurrent(token, expectedRunId, expectedAttemptId)) q('login.error').textContent = error.message;
  }
});
`;

export function loginPage(entryPoint) {
  const label = entryPoint === "welcome" ? "Welcome page" : "Account menu";
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Local login fixture</title>
<body data-entry-point="${entryPoint}"><main>
<h1>Local login fixture</h1><p data-testid="login.entry.${entryPoint}">${label}</p>
<nav><a href="/login/welcome">Welcome entry</a> · <a href="/login/account-menu">Account-menu entry</a></nav>
<section><h2>Choose a fixture-local account</h2>
<p>New: <code data-testid="email.new">${ACCOUNT_EMAILS.new}</code>
<button data-testid="account.new">Continue with new account</button></p>
<p>Existing: <code data-testid="email.existing">${ACCOUNT_EMAILS.existing}</code>
<button data-testid="account.existing">Continue with existing account</button></p></section>
<p>Run: <output data-testid="run.id"></output></p>
<p>Attempt: <output data-testid="attempt.id"></output></p>
<p>Screen: <output data-testid="login.screen">account-choice</output></p>
<p role="status" data-testid="login.status">Choose an account</p>
<section data-testid="captcha.panel" hidden><h2>Test-mode CAPTCHA</h2>
<span data-testid="captcha.mode">${TEST_CAPTCHA.mode}</span>
<span data-testid="captcha.token">${TEST_CAPTCHA.token}</span>
<button data-testid="captcha.complete">Complete test challenge</button></section>
<section data-testid="code.panel" hidden><h2>Verification</h2>
<button data-testid="mailbox.refresh">Read local mailbox</button>
<output data-testid="mailbox.count">0</output>
<input data-testid="code.input" aria-label="Verification code">
<button data-testid="code.submit">Verify</button></section>
<section data-testid="session.panel" hidden>Session: <output data-testid="session.id"></output></section>
<p role="alert" data-testid="login.error"></p>
<script type="application/json" data-testid="observation.json">{}</script>
</main><script>${script}</script></body></html>`;
}

export const indexPage = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Local login fixture</title><body><main><h1>Local login fixture</h1>
<ul><li><a data-testid="entry.welcome" href="/login/welcome">Welcome entry</a></li>
<li><a data-testid="entry.account-menu" href="/login/account-menu">Account-menu entry</a></li></ul>
</main></body></html>`;
