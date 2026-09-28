---
title: How to Test AI Agent Approval Rejection
description: Prove that an AI agent did not execute a rejected tool by checking a complete tool ledger and an independent resource probe with SurfaceLoom and Playwright.
---

# How to test AI agent approval rejection

An agent can display “Denied” and still execute a tool. To catch this, test the approval decision, the tool's execution record, and the resource the tool could change.

This tutorial uses SurfaceLoom's existing four-Case browser showcase. The agent is deterministic, the browser is real, and the resource is a local in-memory note store.

## Run the complete example

Complete the [quick start](../guide/quick-start), then run from the repository root:

```bash
npm --prefix examples/reference-agent run showcase
```

The expected aggregate is **2 passed / 2 failed**, exit **1**. Open the printed output directory's `report/index.html` and compare the three denial Cases below. Exit **2** means the demonstration did not complete correctly.

## What must be true after denial?

| Evidence | Required fact |
| --- | --- |
| Approval observation | The decision belongs to the intended run and call |
| Tool ledger | The intended tool started zero times during a complete observation interval |
| Independent resource probe | No corresponding note was appended |
| Run completion | A known end barrier closes the interval being inspected |

The ledger can contain a **requested** event even when execution never starts. Counting every event as an execution would give the wrong answer.

The [showcase Case definitions](https://github.com/LeonEvo1103/surfaceloom/blob/main/examples/reference-agent/showcase/cases.mjs) connect browser actions to the framework's execution and observation APIs. They retain the independent probes in the report.

## Compare the three denial outcomes

### Healthy denial: zero executions, complete evidence

The browser clicks Deny. The fixture ends the run without starting the tool, the closed ledger proves zero starts, and the local note store remains unchanged. The Case passes.

### Broken denial: the UI says no, but the tool runs

The `deny-but-execute` fixture fault leaves the UI claiming denial while the tool executes. The tool ledger and note store reveal the action. The Case fails even though the UI appears correct.

This is the useful regression check: a future UI-only test must not replace the tool and resource assertions.

### Incomplete ledger: zero cannot be established

The `incomplete-ledger` fault withholds the completion barrier. An empty or partial observation cannot establish that nothing happened during the whole run. The evidence remains unknown and the Case fails.

Waiting an arbitrary extra second or taking another screenshot does not repair a missing completeness contract.

## Inspect the fixture contract in isolation

After the quick-start setup, this executable example shows how the fixture's ledger reader treats a healthy denial. Run it from the repository root:

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { startReferenceAgent, inspectToolCalls } from './examples/reference-agent/src/index.mjs';

const fixture = await startReferenceAgent();
try {
  const run = fixture.createRun();
  fixture.decide(run.runId, 'deny');
  const counts = inspectToolCalls(fixture.readLedger(run.runId), run.runId);
  assert.equal(counts.started, 0);
  console.log('Healthy denial: zero tool starts in a complete ledger.');
} finally {
  await fixture.close();
}
JS
```

This small example checks the local ledger contract only. It does not replace the browser showcase or its independent resource assertion. `inspectToolCalls` throws when the ledger cannot establish a complete, valid interval.

## Apply the pattern to your product

Keep your approval locators, run/call identity mapping, and resource reader in a product adapter. Give the Case a stable specification and explicit criteria, then connect those observations through public framework APIs.

For a real tool, independently inspect the relevant resource: for example, a persisted record or a sandboxed output file. Declare and authorize any effects explicitly. The reference fixture's local note store is not an external-service guarantee.

Continue with [duplicate tool effects](./tool-side-effects), the [Case specification guide](https://github.com/LeonEvo1103/surfaceloom/blob/main/docs/CASE_SPEC.md), or the [reference agent source](https://github.com/LeonEvo1103/surfaceloom/tree/main/examples/reference-agent).
