# SurfaceLoom

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Open-source AI agent testing for browser and native desktop applications.**

SurfaceLoom is an experimental framework for testing whether an AI agent did
the right thing, not merely whether its final answer looked plausible. It
combines approval decisions, tool execution, actual side effects, UI state,
cleanup, and retained evidence in one repeatable Case and one conservative
verdict.

Use SurfaceLoom when a workflow crosses boundaries that ordinary UI assertions
do not cover—for example, when a denied tool must execute zero times, an
approved tool must execute exactly once, or browser and native observations
must agree with the tool ledger. Playwright, macOS Accessibility, Windows UI
Automation, and trace adapters remain replaceable backends; SurfaceLoom owns
the orchestration and verification semantics around them.

## Typical use cases

- **Approval testing:** prove that denial causes no tool execution or resource
  change, and that approval causes exactly the expected execution.
- **Tool side effects:** compare Agent run and tool-call records with an
  independent probe of the resource that may have changed.
- **Failure and cleanup testing:** distinguish `notExecuted`, `executed`, and
  `unknown`, and fail closed when evidence or cleanup is incomplete.
- **Multi-surface testing:** keep browser, native desktop, Agent trace, and
  report evidence attached to the same Case without making a screenshot or
  trace viewer the verdict authority.

## Current status and limits

SurfaceLoom is a runnable engineering experiment with no stable API guarantee.
Its strongest public example is a deterministic Agent approval workflow driven
through a real owned Chrome/Chromium process and the Playwright v3 surface.

- All nine TypeScript packages are currently `private` and are **not published
  to npm**. Work from a repository clone; do not expect a public
  `npm install @surfaceloom/...` path yet.
- The browser approval slice is `live-fixture-tested`. Windows has a separate
  C# client-to-UIA live fixture; macOS native behavior is contract-tested but
  does not yet have live AX proof through the TypeScript path.
- No capability is currently claimed as `target-app-tested`. Product adapters,
  credentials, selectors, and business scenarios stay in downstream
  repositories.
- Real LLMs, external services, invasive permission flows, parallelism,
  sharding, and watch mode are not part of the default verified path.

Capability words are evidence levels, not marketing labels:
`declared` means an interface, manifest, or implementation exists;
`contract-tested` means automated protocol or fake/in-memory behavior tests;
`live-fixture-tested` means a real backend operated a repository-owned neutral
UI; and `target-app-tested` requires recorded execution against a real product
adapter. See the [capability matrix](docs/framework/capabilities.md) for the
current evidence behind every claim.

## Quick start

Prerequisites: Node.js 20 or later, Bash for the repository scripts, and a
usable Chrome or Chromium installation for the live showcase.

```bash
git clone https://github.com/LeonEvo1103/surfaceloom.git
cd surfaceloom

./scripts/run-typescript-tests.sh
npm --prefix examples/reference-agent ci --ignore-scripts
npm --prefix examples/reference-agent run showcase
```

The showcase runs four unique Cases serially through the public Playwright v3
surface and writes one Reporter v3 bundle:

| Case | Expected AUT verdict |
| --- | --- |
| Deny, no execution | passed |
| Approve, exactly one execution | passed |
| Deny, but the tool executes | failed |
| Deny with an incomplete ledger | failed |

Exit `1` is the expected aggregate result: the two injected product faults stay
red, so the report is `2 passed / 2 failed`. Exit `2` means infrastructure,
browser, validation, cleanup, or publication failure, and no final completion
marker is published. The showcase never silently skips a missing browser; set
`SURFACELOOM_BROWSER_EXECUTABLE` when Chrome or Chromium is installed at a
custom path.

For output locations, report inspection, wider validation, and platform
prerequisites, continue with [Getting started](docs/GETTING_STARTED.md).

## What SurfaceLoom solves

- Deterministic assertions over Agent run, approval, tool-call, effect,
  completeness, and cleanup boundaries.
- A single Case model for browser/native actions, Agent observations, retained
  evidence, and a conservative final result.
- Independent side-effect probes that catch duplicate or hidden execution even
  when the UI and tool ledger appear plausible.
- Strict semantic locators that fail on ambiguity instead of silently choosing
  a target.
- Ownership-aware process cleanup: framework-owned processes and user-owned
  processes never share the same termination policy.
- A Reporter that derives JSON, HTML, and AI-review Markdown from one factual
  report instead of asking an LLM to invent the verdict.

SurfaceLoom is not an LLM answer scorer, a computer-use agent, or a replacement
for Playwright, AX, UIA, XCUITest, or Appium. It coordinates those kinds of
backends around a repeatable Agent behavior contract.

## Current capabilities

| Area | Current evidence-backed state |
| --- | --- |
| Browser and execution kernel | The Agent approval slice is `live-fixture-tested` with owned Chrome/Chromium, strict DOM locators, lifecycle/effect assertions, cleanup, and Reporter v3 evidence. |
| Core, Reporter, service, and Judge | Cross-platform contracts, CaseSpec, evidence/reporting, local task service/MCP, and evidence-bound Judge adapters are primarily `contract-tested`; real model use is explicit opt-in. |
| Windows native | The .NET UIA host is `live-fixture-tested` for five neutral WPF/UIA lifecycle Cases through a C# fixture client. This is not proof of a TypeScript-to-UIA path. |
| macOS native | The Swift AX/AppKit library and native stdio host are `contract-tested`, including a real subprocess handshake, but there is no live AX fixture proof through TCC. |
| Component catalog | Manifests are queryable and contract-checked as catalog data. A manifest alone is only `declared` and does not prove an executable component. |
| Target applications | No `target-app-tested` claim is made in this repository. |

The authoritative execution model and roadmap live in the
[Framework SSOT](docs/FRAMEWORK_SSOT.md). The
[capability matrix](docs/framework/capabilities.md) records only what source and
tests currently prove. Items marked `planned`, `ready`, or `in_progress` in the
SSOT are not delivered capabilities.

## Repository layout

```text
packages/
  core/                Platform-neutral contracts, fixtures, and traces
  browser-playwright/  Optional Playwright Core browser backend
  native/              Versioned native protocol and TypeScript client
  test/                Execution kernel, assertions, and CLI
  reporter/            Reporter v2/v3 schemas and deterministic renderers
  agent-loop/          Trace adapters, correlation, and static visualization
  component-catalog/   Desktop, System Surface, and Agent manifests
  service/             Catalog, workspace, execution, MCP, and artifact lifecycle
  llm-judge/           Evidence-bound semantic Judge contracts and adapters
Sources/                Swift macOS backend and native host
native/                 Windows host plus neutral Windows/macOS fixtures
examples/
  reference-agent/     Live browser approval/effect verification showcase
  login-testing/       Contract-tested neutral login and local-mail fixture
projects/               Product-adapter boundary; no real product adapter included
docs/                   Design, capability, authoring, and platform guides
```

The dependency direction is:

```text
Product scenario → Product adapter → Shared/Agent component → Core contract → Platform backend
```

## Playwright browser backend

Use the Playwright backend for DOM content, navigation, forms, and browser
assertions. Use AX or UIA for browser chrome, native windows, permission
prompts, and system file panels. The backend closes only browser processes it
launched and never attaches to the user's existing browser instance.

See [Playwright browser backend](docs/PLAYWRIGHT.md) for installation, API,
locator rules, explicit live smoke tests, artifacts, and safety boundaries.

## Native process transport

The native package provides the `surfaceloom.native/1.0` protocol, a bounded
Node child-process transport, typed desktop-session contracts, and thin
platform bindings. Its contract tests do not by themselves prove that a target
application or descendant process was cleaned up.

See the [native package guide](packages/native/README.md) for connection,
ownership, deadline, cancellation, and operation-receipt semantics.

## Agent-loop visualization

Agent-loop adapters normalize and redact traces, merge only evidence with
explicit identities or bounded timing, and render a self-contained static
timeline. The viewer helps diagnose a run; it never becomes the verdict
authority.

See [Agent-loop traces and visualization](docs/AGENT_LOOPS.md) for the data and
trust model, and the [package guide](packages/agent-loop/README.md) for CLI
commands.

## macOS

The macOS backend requires macOS 14+, Xcode 16+ with Swift Testing, and Swift
tools 5.10. Its default tests are side-effect-free contracts and do not request
or accept Accessibility permissions. See [Getting started](docs/GETTING_STARTED.md#macos)
and the [macOS fixture guide](native/macos-fixture/README.md).

## Windows

The Windows backend requires Windows 10 version 2004+, .NET 8, and an
interactive desktop session for live UIA tests. It does not automate UAC Secure
Desktop or change security settings. See
[Getting started](docs/GETTING_STARTED.md#windows) and the
[Windows host guide](native/windows-host/README.md).

## macOS product-integration example

Product launch policy, localized copy, test IDs, locators, fixtures, and
business scenarios belong in a product adapter rather than shared framework
code. The [Adding tests guide](docs/ADDING_TESTS.md) shows the expected layer,
CaseSpec, locator, and side-effect workflow for product integrations.

## Security model

### Process ownership

- `owned` processes may be cleaned up by SurfaceLoom; `attached` or `external`
  processes are released but never terminated.

### Side-effect levels

- Side effects are declared as `readOnly`, `reversible`, `writesLocal`,
  `externalEffect`, or `securitySensitive`; the final two require explicit
  gates and isolated environments.
- SurfaceLoom does not accept macOS TCC prompts, Windows privacy prompts, or UAC
  dialogs, and it never runs `tccutil reset` automatically.
- Screenshots, traces, accessibility trees, and recordings may contain
  sensitive data. Capture and share them only under an explicit retention and
  redaction policy.

Read the full [security policy](SECURITY.md) before enabling live UI or real
service tests.

## How development agents use the component catalog

Development agents should query existing component and fixture manifests
before adding behavior, keep product-specific text and selectors in the product
adapter, and treat a catalog declaration separately from its implementation
evidence. Shared components change only for a reusable semantic boundary and
must preserve capability, fixture, side-effect, and compatibility contracts.

See [Contributing](CONTRIBUTING.md),
[Adding tests](docs/ADDING_TESTS.md), and the
[component catalog](docs/COMPONENT_CATALOG_V2.md) for the change workflow.

## Documentation

Start with the [documentation map](docs/README.md), organized as:

1. understand the project;
2. run the example;
3. understand the design;
4. contribute.

The two status authorities are the
[Framework SSOT](docs/FRAMEWORK_SSOT.md) and
[capability matrix](docs/framework/capabilities.md). If overview prose
conflicts with them, fix the factual source first and then update the overview.

## Known boundaries

- APIs and manifests may change without notice; packages are private and not
  published to npm.
- The complete TypeScript-to-native-host-to-AX/UIA live path is not yet proven.
- The neutral login fixture is contract-tested but does not yet have a
  Playwright live Case.
- Real LLM calls, real tools, and external side effects are explicit smoke
  tests, not default deterministic tests.
- Live GUI tests require a foreground, unlocked, serially controlled desktop.

## Validation baseline

Before submitting a change, run the checks available on the current platform
and report what actually ran:

```bash
./scripts/check-architecture.sh
./scripts/run-typescript-tests.sh
./scripts/run-swift-tests.sh       # macOS
node scripts/check-framework-ssot.mjs
```

Windows contributors should also run the .NET host contracts and interactive
UIA fixture described in [Getting started](docs/GETTING_STARTED.md#windows).
Skipped or unsupported checks are not passes, and screenshots alone do not
prove tool calls or side effects.

## License

SurfaceLoom is available under the [MIT License](LICENSE).
