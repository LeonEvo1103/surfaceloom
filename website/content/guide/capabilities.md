---
title: Supported Platforms and Verification Limits
description: Understand SurfaceLoom's verified browser, Windows, and macOS capabilities, experimental APIs, and the difference between contract tests and live product evidence.
---

# Supported platforms and verification limits

SurfaceLoom is an experimental framework with no stable API guarantee. A declared interface, a contract test, and a live test establish different things.

## Evidence levels

| Level | Meaning |
| --- | --- |
| `declared` | An interface, manifest, or implementation exists |
| `contract-tested` | Automated protocol, fake, or in-memory behavior tests provide evidence |
| `live-fixture-tested` | A real backend operated a repository-owned neutral fixture |
| `target-app-tested` | Recorded execution against a real product adapter provides evidence |

## Current public scope

| Area | What is established | Important limit |
| --- | --- | --- |
| Browser approval workflow | Real Chrome/Chromium, Playwright v3, approval/effect assertions, cleanup, and Reporter v3 evidence | Deterministic repository-owned reference agent |
| Core, Reporter, service, Judge | Cross-platform contracts, execution, reporting, service/MCP, and evidence-bound Judge adapters | Primarily contract-tested; real model use is explicit opt-in |
| Windows native | Separate C# client-to-UIA fixture with real WPF lifecycle Cases | Does not prove the TypeScript-to-UIA path |
| macOS native | Swift AX/AppKit and native-host contracts, including a subprocess handshake | No live TypeScript-to-AX proof through TCC |
| Component catalog | Queryable, contract-checked manifests | A manifest does not establish executable component behavior |
| Real target products | No public `target-app-tested` claim | Product adapters and credentials stay downstream |

The detailed [capability matrix](https://github.com/LeonEvo1103/surfaceloom/blob/main/docs/framework/capabilities.md) records the source and test evidence. The [framework SSOT](https://github.com/LeonEvo1103/surfaceloom/blob/main/docs/FRAMEWORK_SSOT.md) owns execution semantics and the roadmap. Planned work is not delivered capability.

## Installation and execution boundaries

- All nine TypeScript packages are private and unpublished; use a repository checkout.
- The default verified example does not require an LLM API key or an external service.
- Real models, real external effects, invasive permission flows, parallelism, sharding, and watch mode are outside the default verified path.
- Native live GUI tests require a suitable interactive desktop and explicit permissions. The framework does not automatically accept system permission prompts.
- The browser backend cleans up processes it owns and does not take over your existing browser session.
- A timeout bounds waiting; it does not prove an uncooperative task has stopped. Cleanup needs its own evidence.

## Choosing an entry point

Start with the [browser showcase](./quick-start) to see the strongest public end-to-end example. For platform setup and integration contracts, use the [reference index](./reference). Review the [security policy](https://github.com/LeonEvo1103/surfaceloom/blob/main/SECURITY.md) before running real tools or sharing captured evidence.
