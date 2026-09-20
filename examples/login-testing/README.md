# Local login testing fixture

This example is a neutral, loopback-only login fixture for deterministic browser tests. It uses only Node.js built-ins and never contacts a real identity provider, CAPTCHA service, mailbox, model, company page, or external network.

It is the fixture portion of `SL-P6-040`. Playwright Cases, Judge integration, MCP execution, and Reporter assertions belong to later tasks and are intentionally absent here.

## What it provides

- Two browser entry points: `/login/welcome` and `/login/account-menu`.
- One new and one existing fixture-local account under `login.fixture.test`.
- An explicit test-mode CAPTCHA; only `{ "mode": "test", "token": "fixture-pass" }` is accepted.
- An attempt-local mailbox, verification code, and session.
- Switchable `misrouteExistingToRegistration` and `omitVerificationEmail` faults.
- Stable `run-000001` and `run-000001-attempt-000001`-style identities that are never reused within a fixture instance.
- Deterministic verification codes that are unique across attempts and runs within a fixture instance.
- Explicit run reset and idempotent fixture close.
- A structured observation that separates displayed UI facts from backend flow/effect facts.
- Generation and identity guards in the browser page, so only the newest account start may update attempt-scoped UI.

## Start it

The fixture is intended to be owned by a test and closed in teardown:

```js
import { startLoginFixture } from "./src/index.mjs";

const fixture = await startLoginFixture();
console.log(fixture.baseUrl);
// Open fixture.baseUrl in a browser.
await fixture.close();
```

The listener binds to `127.0.0.1` on an ephemeral port. Requests with another `Host` or `Origin` are rejected. Browser pages load no remote assets.

Starting another account flow immediately clears the displayed attempt ID, mailbox count, code input, session ID, and observation. Delayed responses from the previous flow are ignored after their response identity is checked; they cannot refill the new flow's UI.

## HTTP flow

All POST bodies are JSON objects. The media type must be exactly `application/json`; valid parameters such as `charset=utf-8` are accepted, while lookalikes such as `application/jsonp` are rejected. A normal API-driven attempt is:

1. `POST /api/runs` with `{}` or a `faults` object.
2. `POST /api/runs/:runId/attempts` with `entryPoint`, `accountType`, and the matching fixture-local `email`.
3. `POST /api/runs/:runId/attempts/:attemptId/captcha` with the explicit test-mode challenge above.
4. `GET /api/runs/:runId/attempts/:attemptId/mailbox` to read that attempt's local message.
5. `POST /api/runs/:runId/attempts/:attemptId/verify` with the message's string `code`.
6. `GET /api/runs/:runId/attempts/:attemptId/session` to read that attempt's session.

The accepted account fixtures are:

| `accountType` | email | expected flow |
| --- | --- | --- |
| `new` | `new.user@login.fixture.test` | `registration` |
| `existing` | `existing.user@login.fixture.test` | `sign-in` |

The two `entryPoint` values are `welcome` and `account-menu`.

### Fault control and recovery

Create a faulty run with:

```json
{
  "faults": {
    "misrouteExistingToRegistration": true,
    "omitVerificationEmail": true
  }
}
```

`POST /api/runs/:runId/faults` updates either or both switches. An attempt snapshots the switches when it is created, so changing them cannot rewrite an in-flight attempt. A subsequent attempt observes the new settings.

`POST /api/runs/:runId/reset` with `{}` removes every attempt in the run, clears its mailbox/code/session data, restores both switches to `false`, and increments `resetGeneration`. The run ID remains stable and attempt IDs are not reused.

## Observation contract

`GET /api/runs/:runId/attempts/:attemptId/observation` returns `login-observation/1`:

```json
{
  "schemaVersion": "login-observation/1",
  "identity": { "runId": "run-000001", "attemptId": "run-000001-attempt-000001" },
  "input": { "accountType": "existing", "email": "existing.user@login.fixture.test" },
  "ui": {
    "entryPoint": "welcome",
    "displayedScreen": "sign-in-code",
    "displayedStatus": "Verification code sent"
  },
  "backend": {
    "flow": "sign-in",
    "stage": "awaiting-verification-code",
    "emailDeliveryCount": 1,
    "sessionCreated": false,
    "effects": [
      { "type": "attempt.created" },
      { "type": "flow.selected", "flow": "sign-in" },
      { "type": "email.delivered", "messageId": "run-000001-attempt-000001-mail-000001" }
    ]
  },
  "completeness": { "ui": true, "backend": true, "mailbox": true, "settled": false }
}
```

`input` records the attempt context, `ui` reports what the page displays, and `backend` reports fixture flow, stage, and recorded effects. The observation intentionally has no `rootCause`, fault label, or causal conclusion; a later adapter may compare the fact sets without claiming more than the evidence proves.

Mailbox and session endpoints require both their owning run ID and attempt ID. A code is allocated uniquely, retained by its owning attempt, and compared only after resolving that exact run/attempt pair. It cannot authenticate an attempt from another run, including an attempt whose email was omitted. Reset does not reuse old codes. Returned values are detached snapshots.

## Close semantics

`fixture.close()` is idempotent. It marks non-terminal attempts cancelled, clears all in-memory mailbox/code/session material, closes active HTTP connections, and stops accepting new connections or mutations. Tests should always call it from teardown.

## Test

```bash
npm test
```

The contract suite covers two consecutive successful logins, both entry/account paths, concurrent attempts, cross-attempt leakage, both fault switches and recovery, reset, close, malformed input, local-origin enforcement, and detached observations.

## Limits

- This is an in-memory fixture, not an authentication security implementation.
- It has no persistence or service-restart recovery.
- Its browser page is deliberately minimal and has no Playwright adapter yet.
- It records deterministic fixture facts only; it does not diagnose a product or infer a backend root cause.
