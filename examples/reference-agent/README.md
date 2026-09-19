# Deterministic reference agent

This local fixture implements the `SL-P1-020` approval behavior, the `SL-P1-060`
browser showcase, and the `SL-P3-092` public Agent-provider adapter from
[the framework SSOT](../../docs/FRAMEWORK_SSOT.md). The fixture itself has no model or
external service. Its E2E Cases import framework APIs only from public package roots and
use the repository's Playwright backend and execution kernel against a real owned
Chrome/Chromium process.

```sh
npm --prefix examples/reference-agent ci --ignore-scripts
npm --prefix examples/reference-agent test
npm --prefix examples/reference-agent run test:e2e
```

## M1 one-command showcase

After the repository TypeScript packages have been built and this example has been installed,
run the complete Agent-verdict matrix with one command from the repository root:

```sh
npm --prefix examples/reference-agent run showcase
```

The command launches a new owned headless Chrome session for each Case and runs all four Cases
serially through the public `@surfaceloom/browser-playwright/v3` surface and the existing v3
runner:

| Case | Expected AUT verdict |
| --- | --- |
| Deny, no execution | passed |
| Approve, exactly one execution | passed |
| Deny, but the tool executes | failed |
| Deny with an incomplete ledger | failed |

The aggregate report is intentionally **failed** and the command intentionally exits with code
`1`: the two injected product faults remain red instead of being converted into passing
meta-tests. Exit code `2` means an infrastructure, validation, cleanup, or publication failure.
The command prints the exact output directory. By default it creates a unique directory below
`examples/reference-agent/.artifacts/`; pass an explicit directory as the final argument when a
stable location is useful. Existing output directories are rejected and never overwritten.

The final directory contains `report/report.json`, `report/index.html`,
`report/ai-review.md`, `report/complete.json`, and the evidence attachments referenced by all
four Cases. The aggregator consumes the four in-memory `runCaseV3` results from the current
process, checks their invocation identity and fixed expected verdict matrix, and republishes their
attachments
through the public Reporter v3 API. Reporter v3 copies the attachments and enforces their recorded
sizes and digests. The aggregate is built in a staging directory; child reports are then removed,
and only after cleanup is confirmed is the staging directory atomically renamed into place.

The ordinary unit lane does not require Chrome. The explicit live acceptance lane is mandatory
and never skips a missing browser:

```sh
npm --prefix examples/reference-agent run test:showcase
npm --prefix examples/reference-agent run test:showcase:live
```

## P3-088 fault matrix

The M2 fault matrix is independent from the fixed M1 four-Case showcase and does not change its
aggregate, CLI, IDs, defaults, or expected 2-pass/2-fail result. Run its required live lane with:

```sh
node --test examples/reference-agent/tests/e2e/fault-matrix.e2e.test.mjs
```

It runs eight separate public `defineCaseV3` / `runCaseV3` Cases against owned Playwright browser
sessions. A healthy fixture produces two passing business reports and six intentionally failing
business reports; the Node test itself passes only when every report and its evidence match that
fixed matrix. The seven ordinary rows reuse the M1 execution/cleanup health gate, so an expected
business-red result cannot hide an unrelated teardown failure. The cleanup-unconfirmed row accepts
only its fixed structured resource-cleanup failure chain.

| Case | Expected report | Fault boundary |
| --- | --- | --- |
| Deny but execute | failed | UI is denied while ledger and resource each show one execution |
| Duplicate business effect | failed | One accepted operation writes the same logical note under `call-1` and `call-2` |
| Missing ledger | failed | Detached ledger read explicitly fails; the real resource fact remains visible |
| Truncated ledger | failed | Detached interval retains original sequence/end boundary without its tail |
| Stop before submit | passed | `notExecuted`, closed 1/0/0 ledger, zero stable effects |
| Stop after submit | failed | submitted receipt is `unknown`; UI completion and current zero cannot close evidence |
| Stop after effect | passed | `executed`; the one effect is neither rolled back nor replayed |
| Cleanup unconfirmed | failed | owned run-work times out, taints cleanup, and sibling cleanup is still attempted |

Every Case clicks the real Approve or Deny button. Checkpoints only pause the deterministic fixture
at `before-submit`, `after-submit`, or `after-effect`. Missing/truncated faults modify only the
detached ledger observation response; the underlying append-only ledger and effect store stay real.
The duplicate fault is created inside one accepted executor operation and uses one logical operation
identity independent of `callId`. Point-in-time local effect facts use a separate diagnostic reader
with no completeness claim; the authoritative local-effect reader always requires a complete ledger,
independent of the fixture's fault label.

Each report has one required `agent.fault-matrix.probe` attachment. The live acceptance test rereads
the published `report.json`, final attempt, hosts, browser surface, criteria, raw ledger observation,
diagnostic-only underlying ledger, resource probe, stop/settle receipts, cleanup diagnostics, file
size/SHA-256, and `complete.json` hashes. It then regenerates HTML and AI review through the public
Reporter v3 renderers and requires byte-for-byte equality. Incomplete ledger Cases declare the
required artifact with `requireComplete: false`; that preserves the diagnostic evidence but never
upgrades it into a proof.

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
shares its first bounded close attempt, closes connections even when work does not confirm
settlement, cancels pending runs, and prevents new work. Run and call IDs are
deterministic and stable for the lifetime of one fixture; they are not globally unique
across fixture instances.

The append-note executor has deterministic `before-submit`, `after-submit`, and
`after-effect` checkpoints. They pass automatically in normal M1 runs; fixture tests can
pause, resume, or fail them through the scoped control API. `decide()` remains synchronous
and idempotently accepts one decision, while `settle()` bounds only the caller's wait and
never replays an unconfirmed operation. `stop()` and `emergency` request cooperative
cancellation: their immutable receipt reports `notExecuted`, `unknown`, or `executed` from
the evidence available at the request boundary. Emergency does not claim process/thread
termination or rollback.

## HTTP and UI contract

| Method and path | Behavior |
| --- | --- |
| `GET /?run=<runId>` | Approval UI; without a run ID it offers Start run |
| `POST /api/runs` | Create with JSON `{ "fault": "none" }`; returns 201 |
| `GET /api/runs/<runId>` | Run status, decision, stable IDs and `ended` |
| `POST /api/runs/<runId>/decision` | JSON `{ "decision": "approve" }` or `deny` |
| `POST /api/runs/<runId>/stop` | Cooperative stop; optional JSON `{ "mode": "stop" }` |
| `POST /api/runs/<runId>/emergency` | Cooperative emergency request; no kill/rollback claim |
| `POST /api/runs/<runId>/settle` | Bounded wait with JSON `{ "timeoutMs": 1000 }` |
| `POST /api/runs/<runId>/control` | Fixture-only checkpoint pause/resume/failure control |
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

`ReferenceAgentBrowserAdapter` implements the public `AgentObservationProvider` contract.
It binds a Case author facade to the exact `runId`, `callId`, and `append-note` tool and
uses the named `reference-agent.run-ended:<runId>` barrier for exact lifecycle claims.
Run-state and pre-decision approval assertions each reread one strict atomic JSON snapshot
from the browser UI, so independently changing DOM fields cannot create a torn run/call
identity. Tool lifecycle assertions reread the independent ledger.

The note resource is explicitly `local`, not `external`. Cases therefore use the public
`assertObservation()` reader contract for the independent local resource probe and never
call the external-effect assertion. Deny-zero and its local effect count both require the
same completed run barrier; an incomplete ledger leaves both observations `unknown`.
The Case waits for both probes to settle before returning a failure, so a faster failed
assertion cannot leave the other reader polling after fixture cleanup.

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
