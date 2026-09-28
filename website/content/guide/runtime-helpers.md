---
title: Bound Agent Test Waits and Diagnostics
description: Use SurfaceLoom's runtime helpers for bounded observation, diagnostic collection, and Playwright configuration without hiding unknown execution or cleanup failures.
---

# Bound agent test waits and diagnostics

SurfaceLoom provides reusable helpers for workflows that combine browser actions, agent observations, evidence, and reports. Product adapters still own locators and business expectations.

## Choose the helper for the job

| Need | Public API | Behavior |
| --- | --- | --- |
| Wait for a read-only observation | `waitForObservationBounded` from `@surfaceloom/test` | Returns a structured outcome within the caller's budget |
| Assert an observation inside a criterion | `assertObservationBounded` from `@surfaceloom/test` | Throws a structured failure when the assertion cannot be satisfied |
| Collect optional diagnostics | `captureBoundedDiagnostic` from `@surfaceloom/test` | Bounds collection while preserving the original test failure |
| Configure a browser run | `createPlaywrightBrowserRunOptions` from `@surfaceloom/browser-playwright/v3` | Builds configuration for the existing `runCaseV3` kernel |

These package names are source-checkout imports, not currently published npm installation targets.

## Run the consumer recipe

After the [quick-start setup](./quick-start), run:

```bash
node examples/reference-agent/recipes/runtime-helpers.mjs
node --test examples/reference-agent/test/runtime-helpers.test.mjs
```

The recipe reads a temporary JSON file and local HTTP task state through public APIs, then removes the file and closes the service. It does not call an external service or real model. Its output is helper observation data, not a Case report.

See the [recipe source](https://github.com/LeonEvo1103/surfaceloom/blob/main/examples/reference-agent/recipes/runtime-helpers.mjs) and [full runtime helper guide](https://github.com/LeonEvo1103/surfaceloom/blob/main/docs/RUNTIME_HELPERS.md) for parameter examples and integration into `context.criterion()`.

## Preserve the execution guarantees

Observation callbacks may be repeated, so keep them read-only. Do not place clicks, submissions, emails, or payments inside a polling callback. Treat read errors and unknown evidence as such, rather than converting them to “nothing happened.”

Pass cancellation and the remaining time budget to the underlying operation. A timeout does not forcibly stop arbitrary JavaScript or prove that resources were released. Continue to use the kernel's cleanup receipts.

Diagnostics are supplemental. If a screenshot or ledger is required to establish a result, declare it through required-evidence handling. Best-effort diagnostic collection cannot waive that requirement. A timed-out capture may still be writing its file; do not publish it as complete evidence.

The v3 browser action interface does not currently expose an automatic failure-screenshot action. A diagnostic callback can use an existing screenshot API, but the configuration helper does not create new screenshot or cleanup guarantees.

## When Playwright's own fixtures are enough

For a browser-only test already using Playwright Test, its native fixtures and timeouts may be sufficient. Use SurfaceLoom's helpers where a Case needs to coordinate agent observations and evidence with the shared execution kernel.
