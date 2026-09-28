---
title: How to Detect Duplicate AI Agent Tool Effects
description: Test duplicate tool execution, missing ledgers, and interrupted agent operations using SurfaceLoom's real-browser fault matrix and independent side-effect probes.
---

# How to detect duplicate AI agent tool effects

A tool can appear correct one call at a time and still perform the same business operation twice. SurfaceLoom's reference-agent fault matrix exercises this distinction with a local append-note tool.

## Run the existing fault matrix

First complete the [quick-start setup](../guide/quick-start). From the repository root, run:

```bash
node --test examples/reference-agent/tests/e2e/fault-matrix.e2e.test.mjs
```

This explicit live test requires Chrome or Chromium and does not skip a missing browser. It executes eight Cases with owned browser sessions. The matrix is separate from the four-Case showcase.

::: tip Test-harness result versus business result
The Node test passes only when all eight reports match the expected fault matrix. Inside those reports, **two business Cases pass and six intentionally fail**. This command therefore exits **0** when the acceptance test succeeds, unlike the showcase's expected exit **1**.
:::

## Check business identity as well as call identity

The duplicate-effect fixture accepts one logical operation and writes the same logical note under `call-1` and `call-2`. Each call can look individually well formed while the overall operation is duplicated.

Compare these facts:

1. Which logical operation did the user approve?
2. Which tool calls belong to that operation?
3. How many corresponding effects are present in the independently inspected resource?
4. Is the observation interval complete enough to support an exact count?

Do not use distinct call IDs as proof of distinct user intent. Read the actual [fault assertions](https://github.com/LeonEvo1103/surfaceloom/blob/main/examples/reference-agent/fault-matrix/assertions.mjs) and [Case definitions](https://github.com/LeonEvo1103/surfaceloom/blob/main/examples/reference-agent/fault-matrix/cases.mjs) alongside the test output.

## Read the expected outcomes

| Fault or checkpoint | Business verdict | Reason |
| --- | --- | --- |
| Deny but execute | Failed | Denial conflicts with actual execution and resource change |
| Duplicate business effect | Failed | One logical operation produces two effects |
| Missing ledger | Failed | The tool observation fails; a resource snapshot cannot substitute for it |
| Truncated ledger | Failed | The retained interval is incomplete |
| Stop before submit | Passed | Closed evidence supports `notExecuted` and zero effects |
| Stop after submit | Failed | The operation is `unknown`; current zero effects do not close the interval |
| Stop after effect | Passed | Evidence supports `executed` and one retained effect |
| Cleanup unconfirmed | Failed | Owned work has not confirmed settlement and cleanup remains unproven |

The stop-after-effect Case expects the already completed effect to remain. Cancellation is not rollback, and the runner must not replay an unconfirmed operation to find out what happened.

## Inspect the evidence, not only the exit code

Each Case declares an `agent.fault-matrix.probe` attachment. The [live acceptance test](https://github.com/LeonEvo1103/surfaceloom/blob/main/examples/reference-agent/tests/e2e/fault-matrix.e2e.test.mjs) reads the published report, raw ledger observation, resource probe, stop/settle receipts, and cleanup diagnostics. It also checks attachment sizes and hashes and regenerates the report presentations.

An incomplete ledger is retained for diagnosis without becoming proof of complete execution history. Likewise, a point-in-time resource count is useful evidence but cannot by itself establish that no late effect will occur.

## Scope of this demonstration

This is a deterministic local fixture, not a claim of exactly-once execution against arbitrary external services. It does not test a real model, payment provider, filesystem tool, or production product adapter.

When adapting the pattern, define a stable business-operation identity and a read-only resource probe appropriate to your system. Keep mutating actions out of retrying observation callbacks. Use [bounded runtime helpers](../guide/runtime-helpers) for waits and diagnostics while preserving the runner's cleanup and evidence requirements.
