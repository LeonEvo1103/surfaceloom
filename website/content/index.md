---
layout: home
title: AI Agent Testing for Browser and Desktop Apps
description: Test AI agent approvals, tool execution, and actual side effects. Run a real-browser example with SurfaceLoom and inspect evidence-backed test reports.
hero:
  name: SurfaceLoom
  text: Test what your agent actually did.
  tagline: Connect approval decisions, tool calls, and real side effects in one repeatable test—with evidence you can inspect.
  actions:
    - theme: brand
      text: Run the browser example
      link: /guide/quick-start
    - theme: alt
      text: Explore on GitHub
      link: https://github.com/LeonEvo1103/surfaceloom
features:
  - title: Did “deny” really mean no?
    details: Verify both the tool ledger and an independent resource probe. A rejected-looking UI is only one part of the evidence.
    link: /tutorials/approval-testing
    linkText: Test approval flows
  - title: Did the tool execute twice?
    details: Check the business effect, not just individual call IDs. Exercise duplicate execution and incomplete-evidence faults.
    link: /tutorials/tool-side-effects
    linkText: Test tool side effects
  - title: Can you trust the result?
    details: Keep missing evidence, unknown execution, and unconfirmed cleanup visible. JSON, HTML, and review Markdown share one factual report.
    link: /guide/capabilities
    linkText: See verified capabilities
---

## One example. Four outcomes you can inspect.

The public showcase drives a deterministic reference agent through a **real, framework-owned Chrome or Chromium browser**. No model API key is needed.

| Agent behavior | Expected result | What the test checks |
| --- | --- | --- |
| Denied; tool never runs | Passed | Zero tool executions and zero local effects, with complete evidence |
| Approved; tool runs once | Passed | One execution and one corresponding local effect |
| Denied; tool still runs | Failed | The ledger and resource expose the incorrect execution |
| Denied; ledger is incomplete | Failed | Missing evidence cannot establish zero executions |

The two failures are intentional fixture faults. The showcase retains them as failed reports, so its expected aggregate is **2 passed / 2 failed**, with exit code **1**. [Run and inspect the example →](./guide/quick-start)

## Where SurfaceLoom fits

Use SurfaceLoom when you need to test an agent's behavior across approval, tool, UI, and resource boundaries. It combines replaceable backends such as Playwright, macOS Accessibility, and Windows UI Automation with execution and evidence contracts.

For ordinary browser UI tests, Playwright may already cover your needs. SurfaceLoom adds agent behavior assertions and evidence coordination; it does not replace the browser driver or act as a computer-use agent.

## Experimental, with explicit limits

The browser approval example has live fixture evidence. Windows has a separate C#-to-UIA fixture; the macOS TypeScript-to-Accessibility path is not yet live-proven. No target-product validation is claimed by this public repository. Packages are currently consumed from source and are **not published to npm**.

[Check support and limitations →](./guide/capabilities)
