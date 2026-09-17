# Deterministic reference agent

This local fixture implements the `SL-P1-020` approval behavior and the `SL-P1-060`
browser showcase from [the framework SSOT](../../docs/FRAMEWORK_SSOT.md). The fixture
itself has no model or external service. Its E2E Cases use the repository's Playwright
backend and execution kernel against a real owned Chrome/Chromium process.

```sh
npm --prefix examples/reference-agent test
npm --prefix examples/reference-agent run test:e2e
```

```js
import assert from "node:assert/strict";
import { startReferenceAgent, inspectToolCalls } from "./src/index.mjs";

const fixture = await startReferenceAgent();
try {
  const run = fixture.createRun();
  // A browser can navigate to `${fixture.baseUrl}/?run=${run.runId}` and press Deny.
  fixture.decide(run.runId, "deny");
  const count = inspectToolCalls(fixture.readLedger(run.runId), run.runId);
  assert.equal(count.started, 0);
} finally {
  await fixture.close();
}
```

The HTTP server binds `127.0.0.1` on an OS-assigned port. `close()` is idempotent,
closes connections, cancels pending runs, and prevents new work. Run and call IDs are
deterministic and stable for the lifetime of one fixture; they are not globally unique
across fixture instances.

## HTTP and UI contract

| Method and path | Behavior |
| --- | --- |
| `GET /?run=<runId>` | Approval UI; without a run ID it offers Start run |
| `POST /api/runs` | Create with JSON `{ "fault": "none" }`; returns 201 |
| `GET /api/runs/<runId>` | Run status, decision, stable IDs and `ended` |
| `POST /api/runs/<runId>/decision` | JSON `{ "decision": "approve" }` or `deny` |
| `GET /api/runs/<runId>/ledger` | Detached independent tool observation snapshot |
| `GET /api/runs/<runId>/effects` | The in-memory notes actually appended by the tool |

The page provides `run.start`, `run.id`, `run.status`, `run.error`, `approval.gate`,
`approval.approve`, and `approval.deny` test IDs. Mutations require JSON and accept
only the fixture's own HTTP origin. Repeating the same decision returns the same
terminal run without another tool execution; a conflicting decision returns 409.

## Observation and faults

The executor writes its own append-only ledger, independently of the run's claimed
status. Every call has `requested`, then (only when executed) `started` and `completed`
events. The actual effect is an in-memory note, scoped to this fixture.

`inspectToolCalls()` requires a closed run boundary, a complete contiguous event
interval, matching identity, and valid tool lifecycle. It throws `LedgerIncompleteError`
when these conditions are not met. A pending or truncated observation must never be
treated as a zero-call result. The helper validates trusted fixture observations; it
does not cryptographically authenticate arbitrary fabricated ledgers.

| Fault at creation | Deterministic behavior |
| --- | --- |
| `none` | Deny executes zero; approve executes exactly one |
| `deny-but-execute` | Run claims denied but the tool executes; ledger and effects prove one |
| `incomplete-ledger` | Run ends but no ledger completion barrier is emitted; counts stay unknown |

The unit tests exercise real loopback HTTP and in-memory execution, including duplicate
approvals, corrupt observations, and cleanup. The E2E lane starts an owned browser and
uses semantic DOM locators for deny, approve, injected `deny-but-execute`, and
`incomplete-ledger` Cases. It
fails instead of skipping when no Chromium browser is available; set
`SURFACELOOM_BROWSER_EXECUTABLE` when auto-discovery is insufficient. No real model,
file write, external API, or detached child process is involved.
