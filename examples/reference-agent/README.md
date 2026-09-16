# Deterministic reference agent

This local fixture implements the `SL-P1-020` approval behavior from
[the framework SSOT](../../docs/FRAMEWORK_SSOT.md). It has no model, browser, framework
package, external service, or third-party dependency. The predetermined agent requests
one `append-note` tool call and waits for an explicit approval decision.

```sh
npm --prefix examples/reference-agent test
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

The tests exercise real loopback HTTP and in-memory execution, including duplicate
approvals, corrupt observations, and cleanup. They do not claim live-browser coverage;
the browser adapter and end-to-end Case are the separate `SL-P1-060` task. No background
poller, real model, file write, external API, or detached child process is involved.
