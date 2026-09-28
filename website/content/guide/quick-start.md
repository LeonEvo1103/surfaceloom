---
title: Run Your First AI Agent Browser Test
description: Clone SurfaceLoom, run its four-case real-browser approval example, and inspect the expected two passing and two failing evidence-backed reports.
---

# Run your first AI agent browser test

This guide runs a deterministic reference agent through a real Chrome or Chromium browser. It demonstrates approval decisions, tool execution, independent local side effects, and a single report containing four Cases. It does not call a real LLM or an external service.

## 1. Prepare your machine

You need Node.js 20 or later, npm, Git, Bash, and an installed Chrome or Chromium browser. On Windows, use a Bash environment such as Git Bash for the commands below.

SurfaceLoom's TypeScript packages are currently private and unpublished. Use a source checkout; a public `npm install @surfaceloom/...` installation is not available yet.

## 2. Clone and build

```bash
git clone https://github.com/LeonEvo1103/surfaceloom.git
cd surfaceloom

./scripts/run-typescript-tests.sh
npm --prefix examples/reference-agent ci --ignore-scripts
```

The first script builds and tests the framework packages in dependency order. It does not download a browser. If Chrome or Chromium is installed in a custom location, set `SURFACELOOM_BROWSER_EXECUTABLE` to its absolute executable path in your local environment.

## 3. Run the showcase

```bash
npm --prefix examples/reference-agent run showcase
```

Each Case gets a fresh, owned headless browser session. The four Cases run serially.

| Case | Expected verdict |
| --- | --- |
| Deny, no execution | Passed |
| Approve, exactly one execution | Passed |
| Deny, but the tool executes | Failed |
| Deny with an incomplete ledger | Failed |

::: warning Exit code 1 is expected here
This particular showcase deliberately contains two product faults. A successful demonstration publishes **2 passed / 2 failed** and exits with code **1**. It does not convert the injected failures into passing business results.

Exit code **2** means an infrastructure, browser, validation, cleanup, or publication failure. No final completion marker is published. Missing browsers fail the run; they are not silently skipped.
:::

## 4. Inspect the report

The command prints a unique output directory beneath `examples/reference-agent/.artifacts/`. Open its `report/index.html` in your browser.

```text
report/
  complete.json
  report.json
  index.html
  ai-review.md
  evidence/
```

- **`report.json`** is the factual report.
- **`index.html`** and **`ai-review.md`** are deterministic presentations of those facts.
- **`evidence/`** holds retained attachments referenced by the Cases.
- **`complete.json`** appears only after all four Cases, evidence checks, child-report cleanup, and aggregate publication finish successfully.

Keep execution failures distinct from infrastructure failures. A screenshot alone does not prove that a tool ran, and the presence of a partial output directory does not prove that report publication finished.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Browser cannot be found | Install Chrome/Chromium or set `SURFACELOOM_BROWSER_EXECUTABLE` locally |
| Package imports fail | Run the framework build/test script before installing the example |
| Shell stops after the showcase | Exit 1 is the expected business result; do not hide exit 2 with a blanket `\|\| true` |
| No `complete.json` | Read the command error; incomplete cleanup or publication must be resolved |

The fixture operates on local, in-memory notes. It is not proof of behavior against a real product, external API, or filesystem tool. Before sharing your own reports, review their contents and the repository's [evidence and security policy](https://github.com/LeonEvo1103/surfaceloom/blob/main/SECURITY.md).

## Next steps

- [Prove that approval rejection prevented execution](../tutorials/approval-testing).
- [Detect duplicate effects and incomplete observations](../tutorials/tool-side-effects).
- [Read the full platform setup guide](https://github.com/LeonEvo1103/surfaceloom/blob/main/docs/GETTING_STARTED.md).
