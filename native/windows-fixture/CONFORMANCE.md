# Windows fixture behavior contract

`fixture-contract.v1.json` is the normative inventory. Human-readable intent is summarized here so a
host or client implementation does not infer semantics from visual layout.

## Stable root and observations

- Launch exactly the executable built from `SurfaceLoom.WindowsFixture.csproj`; do not attach to a
  pre-existing process with the same name.
- The unique main window has AutomationId `surfaceloom.fixture.window.main` and Name
  `SurfaceLoom UIA Fixture`.
- Read-only observation fields use the UIA Value pattern. A live test must refresh the field after an
  action; the snapshot returned by an earlier find is not current evidence.
- AutomationId is the stable identity. English Name values exist to test name matching and deliberate
  ambiguity, not as a localization promise for product adapters.

## Required live assertions

1. Find `surfaceloom.fixture.invoke`, invoke it once, then observe value `1` at
   `surfaceloom.fixture.invoke-count`. A second postcondition read may be used; the action must not be
   replayed.
2. Set `SurfaceLoom value ✓` on `surfaceloom.fixture.value-input`, then observe that exact value at
   `surfaceloom.fixture.value-mirror`.
3. Query `button` + Name `Ambiguous action` without an index. Exactly two eligible candidates must be
   observed and strict single-element lookup/action must fail closed as ambiguous. The test must not
   invoke either candidate to prove ambiguity.
4. Invoke `surfaceloom.fixture.transient` once. Prove stable absence using repeated successful
   observations; a stale handle or one missing read is insufficient. Invoke
   `surfaceloom.fixture.transient-restore` during cleanup and prove the original AutomationId is again
   present.
5. Launch as an `owned` application session, observe the root window and ready value, invoke
   `surfaceloom.fixture.lifecycle.close`, and observe the launched PID exiting normally. The host must
   not transfer ownership to another process or treat the closing label as proof of process exit.

Every required action is at-most-once. Timeout, cancellation, transport loss, or a stale element after
submission must preserve an unknown operation outcome and must never cause automatic replay.

## What portable validation proves

The Node tests prove that checked-in files agree on stable IDs and modeled transitions. The .NET model
test proves the state object used by the WPF event handlers. Neither proves Windows UIA provider
behavior, pattern availability, process ownership, process exit, or native protocol integration.
Those claims remain blocked until a Windows live run records OS, host revision, fixture revision,
executed case count, skipped case count, and artifacts.

Run `scripts/live-conformance.ps1` from an interactive Windows session. A conforming run must report
five passed cases, zero skipped cases, and persist the JSON report under `artifacts/`. The report is
generated evidence and is not committed as a timeless claim; the SSOT evidence ledger records the
validated revision and result.
