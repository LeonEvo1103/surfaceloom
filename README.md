# SurfaceLoom

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**AI agent application testing across browser and native desktop surfaces.**

SurfaceLoom is an open-source, experimental testing framework for AI agent
applications. It brings Agent runs, approval decisions, tool calls, side
effects, browser and desktop UI observations, cleanup receipts, and test
evidence into one Case model.

The application under test may use AppKit, SwiftUI, WPF, WinUI, Win32,
Electron, Tauri, or another toolkit, as long as it exposes reliable
Accessibility or UI Automation semantics. SurfaceLoom separates **what behavior
must be proved** from **which backend performs and observes the operation**.
Playwright, native AX/UIA hosts, and trace adapters are infrastructure used by
the framework; SurfaceLoom does not replace those platform engines.

SurfaceLoom is currently a runnable engineering experiment with no stable API
guarantee. It is not yet a mature replacement for XCUITest, Appium, or manual
acceptance testing.

The authoritative implementation plan is
[`docs/FRAMEWORK_SSOT.md`](docs/FRAMEWORK_SSOT.md). The factual implementation
status is tracked in
[`docs/framework/capabilities.md`](docs/framework/capabilities.md). Items marked
`planned`, `ready`, or `in_progress` are not delivered capabilities.

This repository is product-neutral. Concrete product adapters, selectors,
credentials, and business scenarios belong in downstream repositories.

Evidence labels are literal: **declared** means only an interface, manifest, or
source implementation is present; **contract-tested** means automated
protocol/fake behavior tests; **live-fixture-tested** means a real backend
operated a repository-owned neutral UI; and **target-app-tested** requires
recorded execution against a real product adapter. This repository currently
has no target-app-tested claim.

## Typical use cases

SurfaceLoom is designed for developers and test engineers building agentic
applications, desktop copilots, and tool-using AI systems. It is useful when a
test must prove more than a plausible final answer:

- an approval denial produces zero tool executions and zero external effects;
- an approved tool call executes exactly once;
- an emergency stop cancels owned work and produces verifiable cleanup;
- a browser interaction and a native desktop observation belong to the same
  end-to-end Case;
- an Agent trace, effect ledger, UI state, and retained evidence agree before a
  run is allowed to pass.

This makes SurfaceLoom an orchestration and verification layer for Agent
testing, desktop automation, UI automation, Playwright, macOS Accessibility,
Windows UI Automation, and trace adapters. It is not an LLM answer scorer or a
replacement for those platform engines.

## What SurfaceLoom solves

- Deterministic assertions over Agent run, approval, tool-call, effect, and
  completeness boundaries.
- One Case can retain browser/native actions, Agent observations, cleanup, and
  report evidence without treating a trace viewer as the verdict authority.
- Product copy, test IDs, AX roles, and UIA control types stay in product
  adapters instead of leaking into the framework.
- Strict locators fail on ambiguity instead of silently choosing a target.
- Owned processes and user-owned processes have different cleanup semantics.
- Side-effect policy, fixtures, doctor checks, and traces are first-class.
- Component and fixture manifests are queryable by tooling and development
  agents.
- Agent-loop traces can be normalized, redacted, merged, correlated with UI
  evidence, and rendered as a static timeline.

## Current capabilities

| Area | Delivered today |
| --- | --- |
| Core | Cross-platform `Driver`, `Session`, and `Locator` contracts; `CaseSpec`; actionability; fixture runtime; doctor checks; trace redaction |
| Reporter | Reporter v2 compatibility; Reporter v3 host/surface/attempt/execution-platform records; required evidence and artifact integrity; AI-review Markdown; lightweight HTML |
| Native protocol | `surfaceloom.native/1.0` NDJSON protocol; strict framing and duplicate-key rejection; deadlines; cancellation; ownership; normalized and late outcomes; observable close failure; golden vectors; bounded Node child-process transport |
| Native session foundation | Typed application/system desktop-session contracts; AX/UIA locator separation; per-call cancellation; Windows v1 action mapping; ownership-aware, receipt-backed cleanup barriers. Platform bindings are not live yet |
| Component catalog | 37 desktop, System Surface, and Agent manifests plus 7 fixture manifests. A manifest is a declaration, not proof of a live implementation |
| Browser | Optional Playwright Core backend; semantic DOM locators; strict single-target actions; screenshots and traces. The M1 Agent approval slice is live-fixture-tested in owned Chrome/Chromium |
| Agent loop | Extensible `TraceAdapter`; unified event schema; Codex, native, and third-party imports; cross-clock merge; explicit evidence correlation; static HTML timeline |
| Execution kernel | Fixtures/resources, criteria, observation polling, effect policy, deadlines, cleanup receipts, Reporter v3 evidence, and an explicit single-Case v3 CLI path |
| Agent-callable service foundation | Contract-tested service-scoped test/workspace/run/Planner identities, immutable test catalog, executor/workspace/result interfaces, and conservative lifecycle result types. Workspace preparation, process execution, persistence, and MCP are not implemented yet |
| LLM Judge foundation | Contract-tested evidence-bound semantic judgment interface, deterministic Fake provider, explicit `classified`/`insufficient`/`providerFailure` outcomes, absolute deadlines, and separate observed facts/hypotheses. No real model SDK or Reporter integration yet |
| M1 Agent showcase | Four real Playwright v3 Cases run serially against a deterministic reference Agent and produce one Reporter v3 bundle: two expected passes and two honest product failures |
| Neutral login fixture | Browser-ready local HTTP fixture with two entry points, new/existing accounts, attempt-scoped mailbox/CAPTCHA/session state, deterministic fault injection, and reset/cleanup contracts. It is contract-tested, not yet Playwright-live |
| Release contracts | Separate release-plan and final-manifest schemas; exact artifact digests and inventory; SBOM, license, provenance and signature evidence validation; recursive fail-closed archive scanning. No registry publication is performed |
| macOS | Swift AX/AppKit library plus a real `surfaceloom.native/1.0` stdio executable. Protocol, lifecycle, fake-platform backend behavior, and subprocess handshake are contract-tested; there is no TS-to-host or live AX fixture proof |
| Windows | .NET 8 UIA/Win32 backend; isolated `0.2` and `1.0` NDJSON routes; neutral WPF fixture. Verified on Windows 11 with 59 host contract cases and 5 live C#-client-to-UIA cases, with zero skipped |

Still missing are the executable service path (workspace provider, command
executor, persisted runs, and MCP), a real model provider and Reporter Judge
integration, Playwright Cases for the login fixture, platform-specific
TypeScript native bindings, a TypeScript-to-host-to-AX/UIA live path, live AX
conformance for the macOS fixture, target-application evidence, and full runner
features such as parallelism, sharding, and watch mode.

The Agent computer-control and emergency-stop manifests describe UI exposed by
an agent application. SurfaceLoom itself still drives that UI deterministically
through AX, UIA, or the browser backend; it does not ask another agent to click
the screen.

## Repository layout

```text
packages/
  core/                Platform-neutral contracts, fixtures, doctor checks, and traces
  browser-playwright/  Optional Playwright Core browser backend
  agent-loop/          Trace adapters, normalization, correlation, and visualization
  component-catalog/   Desktop, System Surface, and Agent manifests
  reporter/            Reporter v2/v3 schemas and report generators
  native/              Versioned native protocol and TypeScript client
  test/                Execution kernel, assertions, and minimal CLI
  service/             Test catalog and service lifecycle contracts
  llm-judge/           Evidence-bound semantic Judge contracts and Fake provider
Sources/
  SurfaceLoomMacOS/    macOS Accessibility/AppKit backend
  SurfaceLoomMacOSHost/ macOS native/1.0 stdio host and AX adapter
  SurfaceLoomNativeProtocol/ shared Swift wire codec
Tests/
  SurfaceLoomMacOSTests/
native/
  windows-host/        .NET UIA/Win32 NDJSON host
  windows-fixture/     Neutral WPF conformance fixture
  macos-fixture/       Neutral macOS conformance fixture
projects/              Product-neutral framework examples
Templates/             Scenario and fixture templates
docs/                  Architecture, capability, and security documentation
examples/
  reference-agent/     Live browser approval/effect verification showcase
  login-testing/       Contract-tested neutral login and local-mail fixture
```

The intended dependency direction is:

```text
Product scenario → Product adapter → Shared/Agent component → Core contract → Platform backend
```

## Quick start

Prerequisite: Node.js 20 or later.

```bash
git clone https://github.com/LeonEvo1103/surfaceloom.git
cd surfaceloom

./scripts/run-typescript-tests.sh
npm --prefix examples/reference-agent ci --ignore-scripts
./scripts/check-architecture.sh
node scripts/check-framework-ssot.mjs
```

`run-typescript-tests.sh` installs and tests all nine TypeScript packages. The
next command installs the reference example without downloading a browser. The
test script also runs product-contract discovery against any sibling
repositories that explicitly declare a dependency on SurfaceLoom. Product
names and paths are not hard-coded into this repository.

After the TypeScript bootstrap above, the shortest real browser-backed Agent
approval showcase is:

```bash
npm --prefix examples/reference-agent run showcase
```

It runs four unique Cases serially through the public Playwright v3 surface and
prints the generated report path. Exit `1` is the expected showcase result: two
injected Agent faults remain red, so the aggregate is `2 passed / 2 failed`.
Exit `2` means infrastructure, browser, cleanup, or publication failure; no
final completion marker is published for that failure. The showcase requires a
usable Chromium-family browser and never silently skips. Set
`SURFACELOOM_BROWSER_EXECUTABLE` when Chromium is installed at a custom path.

Run the wider framework and reference-Agent acceptance suite with:

```bash
./scripts/run-framework-p1-tests.sh
```

Generate deterministic report fixtures:

```bash
npm --prefix packages/reporter run example -- artifacts/reporter-example
```

Run the checks available on the current platform and record each command's real
exit status, duration, and redacted logs:

```bash
npm --prefix packages/reporter run repository-report
```

On macOS, the repository report runs all nine TypeScript packages, the
architecture guard, and the root Swift contracts. On Windows, it runs all nine
TypeScript packages and the .NET host contracts. These are command-level checks,
not per-case imports.

The report directory contains `complete.json`, `report.json`, `ai-review.md`,
`index.html`, and a relative `evidence/` tree. Screenshots and videos are
retained by default only for failures or timeouts; traces are always retained.
The reporter can archive and render media, but each runner or backend must
capture it explicitly. Missing permissions must be reported as `unsupported`
instead of triggering an authorization prompt. See
[Reporting and AI review](docs/REPORTING.md).

For authoring rules, lifecycle, and failure semantics, see
[the Case specification](docs/CASE_SPEC.md). Every case must define a canonical
Chinese name, original semantics, preconditions, and acceptance criteria.

## Playwright browser backend

Browser automation lives in `packages/browser-playwright` so that Core and the
native backends do not depend on Playwright. Install browsers explicitly after
installing the package. If you use only local Chrome, set `channel: "chrome"`
when launching.

```bash
npm --prefix packages/browser-playwright ci
npx --prefix packages/browser-playwright playwright-core install chromium
```

```ts
import {
  PlaywrightBrowserBackend,
  defineDomLocator,
} from "@surfaceloom/browser-playwright";

const browser = await new PlaywrightBrowserBackend().launch({
  engine: "chromium",
  headless: true,
  context: { baseURL: "https://example.test", locale: "en-US" },
});

try {
  await browser.navigate("/login");
  await browser.fill(
    defineDomLocator({ key: "login.email", kind: "label", text: "Email" }),
    "fixture@example.test",
  );
  await browser.click({
    key: "login.submit",
    kind: "role",
    role: "button",
    name: "Sign in",
  });
} finally {
  await browser.close();
}
```

Use AX or UIA for native windows, menus, permission prompts, and file panels.
Use Playwright for DOM content, navigation, and browser assertions. The browser
backend closes only browser processes that it launched; it does not attach to
or terminate the user's existing browser instance.

See [the Playwright browser backend guide](docs/PLAYWRIGHT.md) for the complete
API, locator model, safety boundaries, and reporter integration.

## Native process transport

The native package now includes a bounded Node child-process transport for a
host that speaks `surfaceloom.native/1.0` over stdio:

```ts
import { NativeClient, NodeProcessTransport } from "@surfaceloom/native";

const transport = new NodeProcessTransport({
  executable: "/absolute/path/to/a/surfaceloom-native-host",
  cwd: "/absolute/host-working-directory",
  env: {},
});

const client = new NativeClient({ transport });
const host = await client.connect();
// Invoke only methods advertised by host.methods, then close explicitly.
await client.close();
```

The Node transport and typed DesktopSession/kernel binding are contract-tested.
The macOS executable is also contract-tested through its Swift codec, fake
platform backend, and a real stdio subprocess handshake. These are separate
facts: the repository still has no platform-specific TypeScript binding and no
complete TypeScript-to-UIA/AX live path. The five Windows live Cases use a C#
fixture client, not `NativeClient` or `NodeProcessTransport`.

## Agent-loop visualization

Normalize, merge, and visualize one or more traces with:

```bash
npm --prefix packages/agent-loop ci
npm --prefix packages/agent-loop run build
node packages/agent-loop/dist/cli.js \
  --input /path/to/trace.jsonl \
  --output /tmp/agent-loop.html \
  --format auto
```

The output is a self-contained static HTML document with no JavaScript and no
external resources. Adapters redact sensitive values before normalization.
Events with absolute timestamps are merged on a shared clock; relative-only
streams remain visible in their own lanes with an explicit warning.

Adapters may also attach UI evidence IDs, window IDs, process IDs, and case or
step context. Correlation is conservative: it uses explicit shared identifiers
and bounded time windows, and it records ambiguous candidates rather than
inventing certainty.

Codex rollout JSONL and SurfaceLoom native traces are built-in reference
adapters. Third-party formats integrate through the public adapter SDK without
modifying the viewer. See [Agent-loop traces and visualization](docs/AGENT_LOOPS.md)
and [the package README](packages/agent-loop/README.md).

## macOS

Requirements:

- macOS 14 or later
- Xcode 16 or later with Swift Testing
- Swift tools 5.10

Run the macOS backend and fixture tests:

```bash
./scripts/run-swift-tests.sh
```

This command runs side-effect-free contract tests only.
`MacOSAutomationDoctor` reads Accessibility authorization with `prompt: false`;
it does not display or accept TCC prompts.

The root Swift package builds the `surfaceloom-macos-host` executable and tests
its real stdio handshake, protocol framing, lifecycle, and backend contracts.
Those tests use a fake platform for AX behavior. They do not launch the neutral
fixture under TCC, prove live AX actions, or connect the TypeScript client.

## Windows

Requirements:

- Windows 10 version 2004 or later
- .NET 8 SDK
- An interactive desktop session for live UIA tests

Build and run the protocol contract tests:

```powershell
cd native\windows-host
dotnet build .\SurfaceLoom.WindowsHost.sln -c Release
dotnet run --project .\tests\SurfaceLoom.WindowsHost.ContractTests -c Release
cd ..\windows-fixture
.\scripts\live-conformance.ps1
```

The live suite launches and cleans up only the fixture process it owns. It does
not automate UAC Secure Desktop or change security settings. A successful run
executes five non-skipped UIA/lifecycle tests and writes local JSON evidence.
See [the Windows host README](native/windows-host/README.md) for protocol and
platform limitations.

From the repository root, install and test the TypeScript packages on Windows
in dependency order:

```powershell
npm --prefix .\packages\core ci
npm --prefix .\packages\core test
npm --prefix .\packages\component-catalog ci
npm --prefix .\packages\component-catalog test
npm --prefix .\packages\reporter ci
npm --prefix .\packages\reporter test
npm --prefix .\packages\agent-loop ci
npm --prefix .\packages\agent-loop test
npm --prefix .\packages\test ci
npm --prefix .\packages\test test
npm --prefix .\packages\browser-playwright ci
npm --prefix .\packages\browser-playwright test
npm --prefix .\packages\native ci
npm --prefix .\packages\native test
```

The latest verified Windows 11 baseline is 59 host contract cases plus 5/5 real
C#-client-to-UIA/lifecycle Cases, with zero skipped. It is not evidence for a
TypeScript-to-UIA path.

## macOS product-integration example

The downstream product adapter owns bundle configuration, profiles, locators,
and components. Scenarios express behavior only:

```swift
struct SettingsComponent: MacOSComponent {
    let driver: MacOSApplicationDriver

    private static let button = MacOSAXLocator(
        "Settings button",
        identifiers: ["settings.open"],
        labels: ["Settings", "Preferences"],
        roles: [MacOSAXRole.button]
    )

    func open() throws { try driver.press(Self.button) }
}

try MacOSTestHarness.withApplication(configuration: configuration) { app in
    try app.component(SettingsComponent.self).open()
}
```

Stable identifiers should come first. Localized labels are fallbacks. Locators
are unique by default and throw when multiple elements match. See
[Adding tests](docs/ADDING_TESTS.md) for the complete integration flow.

## Security model

### Process ownership

- `owned`: launched by SurfaceLoom and eligible for framework cleanup.
- `attached` / `external`: launched by the user or another system; SurfaceLoom
  releases automation references but never terminates it.
- `system`: a system surface such as the desktop or file panel; it does not
  imply access to a secure desktop.

The normal runner refuses to take over an already-running instance of the same
product. A product runner must explicitly enable attach, and the target must be
unique.

### Side-effect levels

| Level | Example | Default policy |
| --- | --- | --- |
| `readOnly` | Inspect a window or state | Allowed in contract tests and CI |
| `reversible` | Open and cancel a file panel | Use an isolated profile |
| `writesLocal` | Modify a fixture file | Use a temporary workspace |
| `externalEffect` | Send a message or call a real service | Prefer fakes; enable real smoke tests explicitly |
| `securitySensitive` | TCC, UAC, or Computer Use control | Use a dedicated user or recoverable VM |

SurfaceLoom does not automatically accept macOS TCC prompts, Windows privacy
prompts, or UAC dialogs. It does not run `tccutil reset` or equivalent commands.
Use dedicated test users or disposable virtual machines for invasive live
tests. GUI runners and target processes may inherit the current environment;
never expose production tokens, cloud credentials, or real model credentials
to live or CI runners. See [the security policy](SECURITY.md).

## How development agents use the component catalog

The catalog can be queried by kind, platform, capability, and maximum side
effect level:

```ts
import { listComponentManifests } from "@surfaceloom/component-catalog";

const safeAgentComponents = listComponentManifests({
  kind: "agent",
  platform: "windows",
  maximumSideEffectLevel: "reversible",
});
```

All seven TypeScript packages are currently marked `private` and are not
published to npm. Tools that do not execute TypeScript may read
`dist/catalog.json` and `dist/fixtures.json` after a build.

Recommended change order:

1. Query the existing component manifests and required fixtures.
2. Keep copy and test-ID changes in `projects/<product>` schemas and locators.
3. Add or change a product scenario for product behavior.
4. Extend a shared component or manifest only for reusable cross-product
   semantics.
5. Put new platform primitives in the backend and add driver contract tests.

Do not advertise a capability based only on an interface, manifest, or fake
test.

## Documentation

- [Framework SSOT](docs/FRAMEWORK_SSOT.md)
- [Capability matrix](docs/framework/capabilities.md)
- [Architecture and dependency boundaries](docs/ARCHITECTURE_V2.md)
- [Component catalog and priorities](docs/COMPONENT_CATALOG_V2.md)
- [Component implementation status](docs/COMPONENT_LIBRARY.md)
- [Adding tests](docs/ADDING_TESTS.md)
- [Case specification](docs/CASE_SPEC.md)
- [Windows design](docs/WINDOWS.md)
- [Playwright browser backend](docs/PLAYWRIGHT.md)
- [Agent-loop traces and visualization](docs/AGENT_LOOPS.md)
- [Open-source references and tradeoffs](docs/OPEN_SOURCE_INSPIRATION.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Known boundaries

- APIs and manifests may change without notice; packages are private and not
  published to npm.
- The macOS backend currently focuses on AX/AppKit. Product-specific TCC flows,
  system dialogs, and XCUITest targets still belong downstream.
- The Windows backend does not yet provide keyboard/mouse injection,
  Notification Center automation, or specialized system file-picker
  components.
- Real LLM calls, real tools, and cross-process probes should be explicit smoke
  tests, not default deterministic tests.
- Live GUI tests require a foreground, unlocked, serially controlled desktop.

## Validation baseline

Before submitting a change, run:

```bash
./scripts/check-architecture.sh
./scripts/run-typescript-tests.sh
./scripts/run-swift-tests.sh
node scripts/check-framework-ssot.mjs
```

On Windows, also run the .NET host contract suite and the five-test interactive
UIA/lifecycle suite described above. Do not treat screenshots alone as proof:
assert semantic state and use probes for tool calls, external writes, and other
side effects.

## License

SurfaceLoom is available under the [MIT License](LICENSE).
