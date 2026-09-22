# SurfaceLoom 能力事实矩阵

> 审计任务：`SL-P0-010`
>
> 基线审计 revision：`aebb24c32f3dec0e7b51c369656cd2d27430dabb`
>
> P1 增量验收 revision：`2f89ea71e981a67c9ac8e0afff529cd77fd89da5`
>
> P2/P3 契约验收 revision：`2ebc6ccae2ce97e373f09d8abb2c97e9c5755a1a`
>
> P2 native client / Windows source revision：`b0aa7fe`
>
> P3 fixture / evidence revision：`2dad348`
>
> Windows host/UIA live revision：`7d79157c9bc2e582d79950ab68b97542243868f4`
>
> Node transport / DesktopSession / release-contract revision：`9a0171386834c5b906d3d6a424641e35697ed85c`
>
> macOS native/1.0 stdio host revision：`96098ced6131d632ffdb473a38caca533411e0d6`
>
> M1 Agent showcase revision：`38eee9ade11205694ae3db1d9a5e0b70ca8feb05`
>
> Agent service / Judge foundation revision：`29eb24f8c7da704ed48eedad2bc786e671b48f09`
>
> Workspace / command / Judge integration revision：`14689246462809d5588b31e07e66e0e2972f4f05`
>
> Durable service / MCP revision：`364e7d8aa442e246b14c615dfd23ee1ab26b3b46`
>
> v3 service executor / failure-origin revision：`777fbb0a9bef55fc607c87ac9fabddbd324eb764`
>
> Packed service consumer / crash recovery revision：`f80632baef0955ba220c573fe6093c98e898524a`
>
> 审计日期：2026-09-21

本文记录基线审计及后续明确列出的验收 revision 中可由源码和测试证明的能力。SurfaceLoom 当前的
框架职责是 Agent 行为验证与测试编排；Playwright、AX/UIA native host 和 trace adapter 是它调用的
backend/基础设施，不是 SurfaceLoom 要重新实现的平台引擎。Windows 已有 C# fixture client→stdio
host→真实 UIA 的 live 证据，但该路径不经过 TypeScript `NativeClient`。macOS 已有真实 native/1.0
stdio executable、Swift codec、fake-platform backend contracts 和 subprocess handshake；这仍不等于
TypeScript binding 或 TCC 下的 live AX。双平台 DesktopSession live 与 fluent desktop author facade
仍不计为已实现。

## 1. 验证级别

| 级别 | 本文采用的判定 |
| --- | --- |
| `declared` | 只有类型、manifest、README 或实现源码；没有足以验证该行为合同的自动化测试。 |
| `contract-tested` | 自动化测试验证类型、fake/in-memory 合同、协议路由或错误语义，但没有与中性真实 UI fixture 的交互证据。 |
| `live-fixture-tested` | 测试真实启动 backend 并操作受仓库控制的中性 UI fixture；必须有该次执行证据，默认 skip 不计。 |
| `target-app-tested` | 经产品 adapter 对真实目标应用运行，并记录目标版本、执行/跳过数量和证据。 |

级别描述的是当前仓库证据，不是源码是否“看起来可用”。下表的 `—` 表示未找到实现或证据；
`partial` 表示只覆盖列出的子集。公开仓库的 [`projects/README.md`](../../projects/README.md)
明确不含产品 adapter，因此本次审计没有任何 `target-app-tested` 项。

## 2. 框架层能力

| 能力 | 实现/声明源码 | 测试证据 | 级别 | 当前限制 |
| --- | --- | --- | --- | --- |
| CaseSpec 语义合同 | [`case-spec.ts`](../../packages/core/src/case-spec.ts) | [`case-spec.test.ts`](../../packages/core/tests/case-spec.test.ts) | `contract-tested` | Core `CaseSpec` 本身保持 execution-independent；attempt、runner 与证据属于 test/reporter 层。 |
| native driver/session SPI | [`driver.ts`](../../packages/core/src/driver.ts) | [`core.test.ts`](../../packages/core/tests/core.test.ts) | `contract-tested` | 是 TypeScript 接口，不是 macOS/Windows 的统一原生实现；没有一个 backend 实现该接口。 |
| semantic locator/match policy | [`locator.ts`](../../packages/core/src/locator.ts) | [`core.test.ts`](../../packages/core/tests/core.test.ts) | `contract-tested` | Core locator 与 AX locator、UIA wire locator 是三套形状，尚无跨语言映射。 |
| guarded element action | [`guarded-actions.ts`](../../packages/core/src/guarded-actions.ts) | [`actionability.test.ts`](../../packages/core/tests/actionability.test.ts)、[`action-deadline.test.ts`](../../packages/core/tests/action-deadline.test.ts) | `contract-tested` | fake backend 验证 precheck 与单次 dispatch；没有原生 bridge，也没有 `executed/unknown/notExecuted` outcome。超时不取消底层 resolver。 |
| fixture lifecycle/registry | [`fixture-runtime.ts`](../../packages/core/src/fixture-runtime.ts)、[`fixture-registry.ts`](../../packages/core/src/fixture-registry.ts) | [`fixture.test.ts`](../../packages/core/tests/fixture.test.ts) | `contract-tested` | Core fixture runtime 支持 test/worker scope、按需 setup、逆序 teardown；deadline、resource receipt 与取消由 execution kernel 叠加，仍无任意 JS 强停。 |
| doctor schema/summary | [`doctor.ts`](../../packages/core/src/doctor.ts) | [`runtime.test.ts`](../../packages/core/tests/runtime.test.ts) | `contract-tested` | 只解析/汇总报告；平台 doctor 仍各自实现。 |
| Core trace recorder | [`trace.ts`](../../packages/core/src/trace.ts) | [`runtime.test.ts`](../../packages/core/tests/runtime.test.ts) | `contract-tested` | 内存事件与脱敏；不是持久化 trace、Case verdict 或跨 surface 因果模型。 |
| component/fixture catalog | [`catalog.ts`](../../packages/component-catalog/src/catalog.ts)、[`fixtures.ts`](../../packages/component-catalog/src/fixtures.ts) | [`catalog.test.ts`](../../packages/component-catalog/tests/catalog.test.ts) | `contract-tested`（仅目录数据） | 测试证明 37 个 manifest 和 7 个 fixture metadata 自洽，不证明对应行为或 fixture setup 可执行。 |
| browser backend | [`backend.ts`](../../packages/browser-playwright/src/backend.ts)、[`session.ts`](../../packages/browser-playwright/src/session.ts) | contract：[`backend.test.ts`](../../packages/browser-playwright/tests/backend.test.ts)、[`session.test.ts`](../../packages/browser-playwright/tests/session.test.ts)；live：[`approval.e2e.test.mjs`](../../examples/reference-agent/tests/e2e/approval.e2e.test.mjs)、[`showcase.e2e.test.mjs`](../../examples/reference-agent/tests/e2e/showcase.e2e.test.mjs) | `live-fixture-tested`（Agent 审批切片） | M1 无 skip 启动真实 owned Chrome/Chromium；截图、trace、storage 等更宽能力仍以 contract 或显式 local smoke 为主。 |
| macOS Swift library | [`SurfaceLoomMacOS`](../../Sources/SurfaceLoomMacOS) | [`SurfaceLoomMacOSTests`](../../Tests/SurfaceLoomMacOSTests) | `contract-tested` | 直接提供 AX/AppKit/CGEvent API；与新 stdio host 是并存实现，不是 TypeScript `DesktopSession` binding。 |
| macOS native/1.0 stdio host | [`SurfaceLoomMacOSHost`](../../Sources/SurfaceLoomMacOSHost)、[`executable`](../../Sources/SurfaceLoomMacOSHostExecutable) | [`SurfaceLoomMacOSHostTests`](../../Tests/SurfaceLoomMacOSHostTests)、[`SurfaceLoomNativeProtocolTests`](../../Tests/SurfaceLoomNativeProtocolTests) | `contract-tested` | 真实 subprocess handshake、framing、lifecycle 与 fake-platform backend 已测；没有 `TS → host`、中性 fixture live AX 或 TCC 证据。 |
| Windows backend | [`SurfaceLoom.WindowsHost`](../../native/windows-host/src/SurfaceLoom.WindowsHost) | [`SurfaceLoom.WindowsHost.ContractTests`](../../native/windows-host/tests/SurfaceLoom.WindowsHost.ContractTests)、[`LiveTests`](../../native/windows-fixture/tests/SurfaceLoom.WindowsFixture.LiveTests) | `live-fixture-tested`（列出的 5 项行为） | Windows 11 最新实跑 59 个 host contracts 与 5 个 WPF/UIA/lifecycle cases、0 skip；live client 是 C# `NativeProcessClient`，不证明 TS platform binding/DesktopSession live。 |
| shared native wire protocol | [`packages/native/src`](../../packages/native/src)、[`Swift codec`](../../Sources/SurfaceLoomNativeProtocol)、[`vectors/v1`](../../packages/native/vectors/v1) | [`packages/native/tests`](../../packages/native/tests)、[`SurfaceLoomNativeProtocolTests`](../../Tests/SurfaceLoomNativeProtocolTests)、macOS subprocess handshake | `contract-tested` | `surfaceloom.native/1.0` 已冻结 framing、deadline、ownership、scope、method descriptor 与 operation outcome；有真实 host 进程合同，但没有 TS client→platform host→native UI live conformance。Windows 0.2 不是兼容别名。 |
| report/v2 | [`model.ts`](../../packages/reporter/src/model.ts)、[`write-report.ts`](../../packages/reporter/src/write-report.ts) | [`report-validation.contract.test.ts`](../../packages/reporter/tests/report-validation.contract.test.ts)、[`reporter.test.ts`](../../packages/reporter/tests/reporter.test.ts) | `contract-tested` | 校验/归档/派生 HTML 和 Markdown；不执行 Case、不采集 UI、不决定 runner cleanup。单 run 只有一个 `platform`，没有 surface/attempt。 |
| report/v3 | [`packages/reporter/src/v3`](../../packages/reporter/src/v3) | [`packages/reporter/tests/v3`](../../packages/reporter/tests/v3)、[`showcase.e2e.test.mjs`](../../examples/reference-agent/tests/e2e/showcase.e2e.test.mjs) | `live-fixture-tested`（M1 报告链） | 保留 host、surface、attempt 与实际 executionPlatforms；M1 聚合真实 Playwright Case 与附件。Reporter 仍只校验/呈现 runner 输入，不自行观察 AUT。 |
| Agent-loop trace | [`adapter.ts`](../../packages/agent-loop/src/adapter.ts)、[`merge.ts`](../../packages/agent-loop/src/merge.ts) | [`adapters.test.ts`](../../packages/agent-loop/tests/adapters.test.ts)、[`merge-render.test.ts`](../../packages/agent-loop/tests/merge-render.test.ts) | `contract-tested` | 导入、脱敏、合并和静态展示；不运行 Agent、不证明 ledger completeness、不产生 authoritative verdict。 |
| explicit evidence correlation | [`evidence-context.ts`](../../packages/core/src/evidence-context.ts)、[`correlation`](../../packages/agent-loop/src/correlation)、[`runner v3 evidence`](../../packages/test/src/evidence) | contract tests 与 M1 Reporter v3 evidence artifacts | `live-fixture-tested`（仅 M1 runner evidence 路径） | M1 实跑证明 runner 提交的 run/call/probe 关联进入报告；Agent-loop correlation helper 本身仍只有 contract 证据。两者都只接受显式、有来源的关系与 event binding；时间/相邻事件不产生因果，trace viewer 也不产生 authoritative verdict。 |
| execution kernel | [`execute.ts`](../../packages/test/src/execute.ts)、[`runner-v3.ts`](../../packages/test/src/runner-v3.ts) | [`execution-lifecycle.test.ts`](../../packages/test/tests/execution-lifecycle.test.ts)、reference-agent live E2E | `live-fixture-tested`（Agent 浏览器切片） | effect policy、deadline、resource receipt、fixture teardown 与 v3 evidence 已进入 live slice；仍不能强停任意 in-process JavaScript，native TS backend 尚未接入。 |
| Agent observation assertions | [`agent-observation.ts`](../../packages/test/src/agent-observation.ts) | [`agent-observation.test.ts`](../../packages/test/tests/agent-observation.test.ts) | `contract-tested` | `toHaveRunState`、approval/tool-call/exactly-once/no-external-effect 均绑定显式 run/call/resource；exact/negative 结论要求完成 barrier。provider 的账本真实性仍是 adapter 信任边界。 |
| `sl-test` CLI/report 接线 | [`cli`](../../packages/test/src/cli)、[`report`](../../packages/test/src/report) | [`cli`](../../packages/test/tests/cli)、[`report`](../../packages/test/tests/report) | `contract-tested` | v2 支持发现/过滤/顺序执行；v3 config 必须精确选择单 Case。M1 用公开 `runCaseV3` 四次串行编排并生成单一 v3 bundle；无通用 multi-Case v3 CLI、worker pool、sharding 或 watch。 |
| Agent-callable service foundation | [`packages/service/src`](../../packages/service/src) | 包内：[`packages/service/tests`](../../packages/service/tests)；仓外：[`scripts/service-packed-consumer`](../../scripts/service-packed-consumer) | `contract-tested` | 101 项包内测试覆盖稳定 catalog、本地不可变 Git snapshot、registered-argv command executor、单进程 durable store、SurfaceLoom v3 executor，以及正式 MCP SDK v2 的七个工具。仓库外 consumer 另只从 5 个候选 `.tgz` 安装公开 exports，实跑 CLI/v3、prepare→run→reconnect→artifact→cancel、dispatch 后响应丢失、service crash+存活 child、cleanup unconfirmed、exactly-once replay 与 tainted workspace 拒绝复用。当前仅监听 loopback；一个 v3 service test 只映射一个 Case；prepare operation 不跨 service 重启持久化；没有远程 auth、多 writer store、数据库/分布式 scheduler 或内建生产级平台 process-tree controller。候选仍需同时安装完整内部包闭包，尚未满足 registry 发布的 `private`/`file:` 清理门槛。 |
| LLM Judge + Reporter v3 integration | [`packages/llm-judge/src`](../../packages/llm-judge/src)、[`packages/test/src/judge`](../../packages/test/src/judge)、[`packages/reporter/src/v3/judge`](../../packages/reporter/src/v3/judge) | [`packages/llm-judge/tests`](../../packages/llm-judge/tests)、[`packages/test/tests/judge`](../../packages/test/tests/judge)、[`packages/reporter/tests/v3/judge`](../../packages/reporter/tests/v3/judge) | `contract-tested` | Case 可显式声明 Judge criterion；当前 attempt 的有界文本/PNG/JPEG/WebP evidence、Case deadline/cancel、三态结果和 correlation 进入 Reporter v3 required artifacts，retention off 也不能删除所需证据。提供 OpenAI Responses-compatible 与 Anthropic 官方 SDK adapter，覆盖 structured output、deadline、401/429/5xx、metadata 和 invalid response；OpenAI-compatible 已做一次显式真实 API smoke，但不进入默认 CI，Anthropic 尚无真实 API 证据。确定性失败、证据不完整和 provider failure 均不能被改绿。 |
| reference-agent M1 fixture/ledger/showcase | [`examples/reference-agent`](../../examples/reference-agent) | [`approval.test.mjs`](../../examples/reference-agent/test/approval.test.mjs)、[`showcase unit`](../../examples/reference-agent/test/showcase-aggregate.test.mjs)、[`showcase live`](../../examples/reference-agent/tests/e2e/showcase.e2e.test.mjs) | `live-fixture-tested` | 一条命令串行执行 deny=green、approve=green、deny-but-execute=red、incomplete-ledger=red，真实 Chrome 0 skip，单一 v3 bundle 为 2 pass/2 fail/exit 1；infra/cleanup/publication failure 为 exit 2 且无 final complete。无真实模型、native surface 或外部 effect。 |
| neutral login fixture | [`examples/login-testing/src`](../../examples/login-testing/src) | [`examples/login-testing/test`](../../examples/login-testing/test) | `contract-tested` | 本地 HTTP fixture 覆盖两个入口、全新/旧账号、attempt 隔离、本地邮箱/验证码/session 与故障/页面竞态；尚无 Playwright、Judge、MCP、Reporter 或真实邮箱集成。 |
| native TS client / shared wire conformance | [`client`](../../packages/native/src/client) | [`client tests`](../../packages/native/tests/client) | `contract-tested` | 97 个 native package tests 覆盖 client、协议、process transport 与 DesktopSession contract；尚无 `TS → platform binding → UIA/AX` live conformance。 |
| Node host-process transport | [`node-transport`](../../packages/native/src/node-transport) | [`node-transport tests`](../../packages/native/tests/node-transport) | `contract-tested` | 28 项专项覆盖真实 child spawn、fatal UTF-8、framing、write admission、bounded stderr、close/exit 分证据与对抗生命周期；不证明目标应用或后代进程已清理。 |
| typed DesktopSession / kernel binding | [`desktop-session`](../../packages/native/src/desktop-session)、[`native-binding`](../../packages/test/src/native-binding) | [`desktop-session tests`](../../packages/native/tests/desktop-session)、[`native-binding tests`](../../packages/test/tests/native-binding) | `contract-tested` | AX/UIA 类型隔离、Windows v1 method/action mapping、per-call deadline/signal、late acquisition 与 identity-bound cleanup receipt 已覆盖；平台 codec/binding 和真实 UI 尚未接入。 |
| release plan / final manifest contract | [`release docs`](../release/README.md)、[`validators`](../../scripts/release) | [`release contract tests`](../../scripts/tests/release-contract) | `contract-tested` | 37 项测试保留原七包 v1 schema、历史迭代顺序与证据，并以独立 v2 固定当前九包和 `test → llm-judge` 拓扑；同时覆盖最终 bytes/digest/inventory、SBOM/license/provenance/signature evidence 与递归 archive budget。不执行 build、签名、notarization、上传或 registry 发布。 |
| Windows neutral UIA fixture | [`windows-fixture`](../../native/windows-fixture) | [`portable tests`](../../native/windows-fixture/tests)、[`live conformance`](../../native/windows-fixture/scripts/live-conformance.ps1) | `live-fixture-tested`（5 项） | 真实覆盖 invoke、setValue/mirror、strict ambiguity、transient recovery、owned close；没有 Dialog 行为，也没有 TS client/Node transport live。最终报告当前仍需加强来源与 cleanup 收口。 |
| macOS neutral AX fixture | [`macos-fixture`](../../native/macos-fixture) | [`fixture tests`](../../native/macos-fixture/Tests) | `contract-tested`（model/static/artifact） | 8 Swift model + 13 Node parity/static/artifact tests；可重复构建带稳定 bundle ID、Info.plist 与内嵌 contract 的 `.app`。未启动 GUI、未请求 TCC、未执行 live AX。 |

## 3. Core capability registry 与 backend 事实

Core 在 [`capabilities.ts`](../../packages/core/src/capabilities.ts) 声明 30 个字符串。声明进入 registry
只代表可用于协商；它不保证任何 backend 已实现。下表标记通用 capability contract：`CT` 表示该
通用合同达到 `contract-tested`，`D` 表示只到 `declared`。它不会因某个较窄的 fixture 行为已有 live
证据就把整个通用 capability 升为 live；已验证的 browser/Windows live 子集以第 2 节和第 4 节为准。
每一行的声明源码均为上述 registry；registry/协商 helper 的测试入口是
[`core.test.ts`](../../packages/core/tests/core.test.ts)，平台行为的源码和测试入口列在表后。

| Core capability | Browser Playwright | macOS Swift | Windows NDJSON host |
| --- | --- | --- | --- |
| `app.launch` | — | CT：owned launch/清理合同 | CT：`session.launch` |
| `app.attach` | — | CT：唯一进程与 attached ownership | CT：按 PID `session.attach` |
| `app.quit` | — | D：Quit menu/shortcut 组件路径 | CT(partial)：owned `WM_CLOSE`，不保证完整退出 |
| `app.terminate` | — | CT：仅 owned process | CT：仅 owned process tree |
| `ui.inspect` | — | CT：AX identifier/label/role 与 strict match | CT：UIA find/findAll/get/batch |
| `ui.invoke` | — | D：AXPress 实现 | CT：UIA Invoke/Select/Toggle/Expand/Collapse/Focus |
| `ui.set-value` | — | D：AXValue 实现 | CT：UIA ValuePattern |
| `ui.wait` | — | D：轮询 exists/disappear | CT：find/findAll wait；batch 本身不 wait |
| `window.inspect` | — | D：按 PID 观察 on-screen window 数 | CT(partial)：创建 session 时定位 root window |
| `window.manage` | — | D(partial)：关闭快捷键、reopen、可见性等待 | —：没有通用 focus/close/minimize/restore API |
| `menu.invoke` | — | D：`MenuComponent` + AXPress | CT(partial)：可对可访问 menu item 做通用 UIA action |
| `keyboard.inject` | — | D：CGEvent shortcut | 明确 unsupported |
| `pointer.inject` | — | D：显式 `clickCenter` CGEvent API；不是 AXPress 的静默 fallback | 明确 unsupported |
| `clipboard.read` / `clipboard.write` | — | — | — |
| `drag-drop.perform` | — | — | — |
| `screenshot.capture` | CT；backend 对外 advertise | — | — |
| `browser.navigate` | CT；对外 advertise | — | — |
| `browser.dom.inspect` | CT；对外 advertise | — | — |
| `browser.dom.invoke` | CT；对外 advertise | — | — |
| `browser.trace` | CT；对外 advertise | — | — |
| `browser.network.observe` | CT：`observe()` 有 request/response 事件，但 capability 数组未 advertise | — | — |
| `browser.console.observe` | CT：`observe()` 有 console/page-error 事件，但 capability 数组未 advertise | — | — |
| `browser.network.proxy` | CT；对外 advertise | — | — |
| `browser.storage.export` | CT：`saveStorageState()` 已实现，但 capability 数组未 advertise | — | — |
| `system.open-save-panel` | — | CT(partial)：只测输入拒绝；真实 panel roundtrip 未测 | D(partial)：desktop root 可遍历；无专用组件 |
| `system.permission.inspect` | — | CT(partial)：doctor 观察 runner AX trust，不是产品 permission-consent 组件 | — |
| `system.notification.inspect` | — | — | — |
| `system.status-area.inspect` | — | — | — |
| `system.elevation.observe` | — | — | 明确不支持 UAC Secure Desktop；没有通用 elevation observation API |

Browser 行为测试主要使用 [`fakes.ts`](../../packages/browser-playwright/tests/fakes.ts)；network/console
观察见 [`observation.test.ts`](../../packages/browser-playwright/tests/observation.test.ts)，storage export 见
[`storage-state.test.ts`](../../packages/browser-playwright/tests/storage-state.test.ts)。macOS 对应源码集中在
[`MacOSApplicationDriver.swift`](../../Sources/SurfaceLoomMacOS/Core/MacOSApplicationDriver.swift)、
[`MacOSApplicationDriver+Accessibility.swift`](../../Sources/SurfaceLoomMacOS/Core/MacOSApplicationDriver+Accessibility.swift)
和 [`MacOSApplicationDriver+AccessibilityActions.swift`](../../Sources/SurfaceLoomMacOS/Core/MacOSApplicationDriver+AccessibilityActions.swift)。
Windows 能力声明与边界见 [`CapabilityCatalog.cs`](../../native/windows-host/src/SurfaceLoom.WindowsHost/Automation/CapabilityCatalog.cs)，
协议合同入口见 [`Program.cs`](../../native/windows-host/tests/SurfaceLoom.WindowsHost.ContractTests/Program.cs)。

## 4. Browser live smoke 的门禁

真实浏览器用例存在于 [`local-smoke.test.ts`](../../packages/browser-playwright/tests/local-smoke.test.ts)
和 [`local-features.test.ts`](../../packages/browser-playwright/tests/local-features.test.ts)，会启动系统 Chrome，
操作 data URL/本地 HTTP fixture，并验证 DOM、严格匹配、trace、截图、observation 和 storage replay。
但两组测试都只有在 `SURFACELOOM_BROWSER_SMOKE=1` 时运行；默认 `npm test` 会报告 skip。
[`run-local-smoke.mjs`](../../packages/browser-playwright/scripts/run-local-smoke.mjs) 只由显式
`npm run test:local` 入口设置该变量。这些可选 smoke 所覆盖的 trace、截图、observation 和 storage
能力仍不能因默认 skip 升级为 live。与其不同，M1 showcase 是 0 skip 的真实 owned Chrome/Chromium
门禁，已经把 Agent 审批切片升级为 `live-fixture-tested`。两类中性 fixture 都不是产品 adapter，
因此都不能升级为 `target-app-tested`。

## 5. 37 个 component manifest 与行为实现

[`catalog.test.ts`](../../packages/component-catalog/tests/catalog.test.ts) 证明当前数量为 37：15 common、
8 system、14 agent。[`helpers.ts`](../../packages/component-catalog/src/helpers.ts) 默认给每个条目同时声明
`macos` 和 `windows`；这只是目录声明。下面的“实现”只列可找到的行为代码，不把通用 AX/UIA 原语
自动算作组件完成。每一行的 manifest 源码分别位于 [`common.ts`](../../packages/component-catalog/src/common.ts)、
[`system.ts`](../../packages/component-catalog/src/system.ts) 或 [`agent.ts`](../../packages/component-catalog/src/agent.ts)，
声明测试均为上述 `catalog.test.ts`；行为专属测试仅在该行明确链接。目录 metadata 的测试不会把行为
级别从 `declared` 升级。

| Manifest | 行为实现源码 | 行为验证级别 | 限制 |
| --- | --- | --- | --- |
| `desktop.common.app-lifecycle` | macOS [`ApplicationLifecycleComponent.swift`](../../Sources/SurfaceLoomMacOS/Components/ApplicationLifecycleComponent.swift)；Windows session lifecycle | `contract-tested`（backend 子合同） | ownership/失败清理测试见 [`MacOSApplicationOwnershipTests.swift`](../../Tests/SurfaceLoomMacOSTests/MacOSApplicationOwnershipTests.swift)、[`MacOSLaunchCompletionTests.swift`](../../Tests/SurfaceLoomMacOSTests/MacOSLaunchCompletionTests.swift) 和 [Windows contract runner](../../native/windows-host/tests/SurfaceLoom.WindowsHost.ContractTests/Program.cs)；没有统一组件 API 或 live fixture。 |
| `desktop.common.window` | macOS [`WindowComponent.swift`](../../Sources/SurfaceLoomMacOS/Components/WindowComponent.swift) | `declared` | 只含可见/隐藏观察；Windows 无 manifest action 对应实现。 |
| `desktop.common.menu` | macOS [`MenuComponent.swift`](../../Sources/SurfaceLoomMacOS/Components/MenuComponent.swift) | `declared` | 无组件测试/live conformance。 |
| `desktop.common.toolbar` | — | `declared` | 只有 [`common.ts`](../../packages/component-catalog/src/common.ts) manifest。 |
| `desktop.common.navigation` | — | `declared` | 同上。 |
| `desktop.common.tabs` | — | `declared` | 同上。 |
| `desktop.common.dialog` | macOS [`DialogComponent.swift`](../../Sources/SurfaceLoomMacOS/Components/DialogComponent.swift) | `declared` | 无组件测试/live conformance。 |
| `desktop.common.alert` | — | `declared` | 只有 manifest。 |
| `desktop.common.form` | partial：macOS TextInput；Windows UIA setValue/invoke | `declared` | 没有 Form 组件或 submit/validation 合同。 |
| `desktop.common.text-editor` | partial：macOS [`TextInputComponent.swift`](../../Sources/SurfaceLoomMacOS/Components/TextInputComponent.swift)；Windows UIA setValue | `declared` | 没有 selection/rich text/typeText conformance。 |
| `desktop.common.search` | — | `declared` | 只有 manifest；底层 setValue 不等于搜索行为。 |
| `desktop.common.collection` | macOS [`CollectionComponent.swift`](../../Sources/SurfaceLoomMacOS/Components/CollectionComponent.swift)；Windows generic UIA Select | `declared` | macOS 只含 count/select；无组件测试。 |
| `desktop.common.context-menu` | — | `declared` | Windows 明确无 pointer injection。 |
| `desktop.common.command-palette` | — | `declared` | 只有 manifest。 |
| `desktop.common.web-view` | —；browser backend 是独立包 | `declared` | 没有 native web-view 到 browser session 的 handoff/binding。 |
| `desktop.system.open-save-panel` | macOS [`NativeFileDialogComponent.swift`](../../Sources/SurfaceLoomMacOS/SystemSurfaces/NativeFileDialogComponent.swift)；Windows generic desktop traversal | `contract-tested`（partial） | [`NativeFileDialogComponentTests.swift`](../../Tests/SurfaceLoomMacOSTests/NativeFileDialogComponentTests.swift) 只测非目录输入拒绝；无真实 dialog roundtrip，Windows 无专用组件。 |
| `desktop.system.clipboard` | — | `declared` | 只有 [`system.ts`](../../packages/component-catalog/src/system.ts) manifest。 |
| `desktop.system.keyboard-shortcut` | partial：macOS `pressShortcut` primitive | `declared` | 没有独立组件或真实输入测试；Windows unsupported。 |
| `desktop.system.drag-drop` | — | `declared` | 两个 native backend 都无该合同。 |
| `desktop.system.status-area` | — | `declared` | Windows desktop root 不等于 tray 组件。 |
| `desktop.system.dock-taskbar` | — | `declared` | 只有 manifest。 |
| `desktop.system.permission-consent` | partial：平台 doctor 安全边界 | `declared` | doctor 不执行 manifest 的 request/cancel 行为。 |
| `desktop.system.elevation-authorization` | partial：Windows 显式拒绝 Secure Desktop | `declared` | unsupported 声明不是 observe/cancel 组件实现。 |
| `desktop.agent.conversation` | — | `declared` | 只有 [`agent.ts`](../../packages/component-catalog/src/agent.ts) manifest。 |
| `desktop.agent.composer` | — | `declared` | 只有 manifest。 |
| `desktop.agent.streaming-response` | — | `declared` | fixture id 只是 metadata。 |
| `desktop.agent.model-picker` | — | `declared` | 只有 manifest。 |
| `desktop.agent.attachment` | — | `declared` | filesystem fixture 未注册可执行 setup。 |
| `desktop.agent.tool-call` | partial：[`reference-agent ledger`](../../examples/reference-agent/src/ledger.mjs) | `live-fixture-tested`（参考行为） | 证明受控 fixture 的 requested/started/completed 与完成 barrier；尚未成为 catalog component 的通用 executable definition。 |
| `desktop.agent.approval` | partial：[`reference-agent cases`](../../examples/reference-agent/cases/approval-cases.mjs) | `live-fixture-tested`（参考行为） | 真浏览器覆盖 deny 0、approve 1、错误执行与不完整 ledger；尚无 native/mixed surface 和通用 component facade。 |
| `desktop.agent.permission-mode` | — | `declared` | 只有 manifest。 |
| `desktop.agent.task-run` | partial：[`reference-agent engine`](../../examples/reference-agent/src/engine.mjs) | `live-fixture-tested`（参考行为） | 有确定性 run completion/ledger barrier；当前 tool executor 同步，尚不能证明执行中 emergency stop。 |
| `desktop.agent.computer-control` | — | `declared` | input-event probe 未实现。 |
| `desktop.agent.emergency-stop` | — | `declared` | 没有停止后完整观察区间证明。 |
| `desktop.agent.session-recovery` | — | `declared` | recovery-state fixture 未实现。 |
| `desktop.agent.artifact` | — | `declared` | 只有 manifest。 |
| `desktop.agent.terminal` | — | `declared` | command fixture/probe 未实现。 |

macOS `MacOSAppSession` 当前确实暴露 7 个行为组件：lifecycle、window、menu、dialog、text input、
collection、native file dialog，入口见 [`MacOSComponent.swift`](../../Sources/SurfaceLoomMacOS/Components/MacOSComponent.swift)。
这 7 个 Swift 类型不是 37 个 manifest 的一一实现，也不实现 TypeScript `DesktopDriver`。
Windows 当前没有对应的 component 类；它提供更低层的 UIA host 与 .NET safe-client 构件。

7 个 fixture catalog 条目同样全部只到 `declared`：源码是
[`fixtures.ts`](../../packages/component-catalog/src/fixtures.ts)，测试只验证 ID 唯一和 manifest 引用可解析。
Core [`FixtureRegistry`](../../packages/core/src/fixture-registry.ts) 能在消费者注册定义，但公开仓库没有为
`desktop.filesystem-sandbox`、`agent.scripted-run`、`agent.tool-fixture`、`agent.side-effect-probe`、
`agent.input-event-probe`、`agent.recovery-state`、`agent.command-fixture` 提供可执行 definition。

## 6. Native bridge 与协议现状

### macOS

- 根 [`Package.swift`](../../Package.swift) 同时发布 `SurfaceLoomMacOS` Swift library 和
  `surfaceloom-macos-host` executable。host 通过 [`SurfaceLoomNativeProtocol`](../../Sources/SurfaceLoomNativeProtocol)
  实现 `surfaceloom.native/1.0` NDJSON framing、host descriptor、deadline/cancel、ownership、action result
  与共享 golden vectors。
- [`SurfaceLoomMacOSHostTests`](../../Tests/SurfaceLoomMacOSHostTests) 覆盖真实 subprocess handshake、
  stdout/wire 隔离、backpressure、迟到 launch/ownership、cleanup single-flight、断管与 fake-platform
  backend 行为。这些是 host contract，不是 TypeScript client binding，也不是 live AX。
- 仓库已有中性 AppKit fixture 源码、build/model contracts 和稳定 `.app` artifact；该产物尚未在
  TCC 授权身份下由 stdio host 启动和操作，因此没有中性 fixture live AX 或目标 App 证据。

### Windows

- [`HostProtocol.cs`](../../native/windows-host/src/SurfaceLoom.WindowsHost/Protocol/HostProtocol.cs) 保留显式
  legacy NDJSON `0.2`；[`NativeV1Dispatcher.cs`](../../native/windows-host/src/SurfaceLoom.WindowsHost/Host/NativeV1Dispatcher.cs)
  实现严格隔离的 `surfaceloom.native/1.0` 路由、scope/ownership、deadline/cancel 与 operation receipt。
- [`AutomationContracts.cs`](../../native/windows-host/src/SurfaceLoom.WindowsHost/Protocol/AutomationContracts.cs)
  定义 UIA locator、session ownership、element snapshot 和 action；
  [`RequestDispatcher.cs`](../../native/windows-host/src/SurfaceLoom.WindowsHost/Host/RequestDispatcher.cs)
  在单进程内路由请求。
- 合同可执行程序最新登记 59 个协议/安全检查，已在 Windows 11/.NET 8 实跑。中性 WPF fixture 也通过
  C# process client 完成 5 个不可跳过的 launch → find → action → postcondition/lifecycle live Case。
  该证据不经过 TypeScript client，且 fixture 当前没有 Dialog 行为。
- 1.0 `element.action` 用 `notExecuted/executed/unknown` receipt 保守表达提交边界，超限响应与 deadline
  fallback 保留 outcome；legacy 0.2 不获得这些语义，也不被重标为 1.0。
- host feature 名称（例如 `uia.semanticActions`）不是 Core capability registry 的直接实现声明；已有
  transport-neutral TypeScript client、真实 Node process transport 与 typed desktop/kernel contract；平台
  binding 尚未把这些合同接到 UIA/AX live surface。

结论：shared protocol、TS client、Node process transport、typed DesktopSession contract、macOS 1.0
stdio host contract、Windows 1.0 host 和 Windows C#→UIA live 分别落地；尚无 `TypeScript → platform
binding → typed DesktopSession → shared protocol → native UI` live 证据。macOS host contracts 不能
扩大解释为 live AX，Windows 5/5 也不能扩大解释为统一 TS→UIA 链路完成。

## 7. Reporter 与 Agent loop 的权威边界

Reporter 接受调用方提供的 `CaseSpec + result`，校验状态/验收项关联，按 policy 复制证据，并从
`report.json` 确定性生成 HTML/AI Markdown。其测试证明 schema、脱敏、路径与制品处理；没有代码负责
执行动作、等待 assertion、创建 fixture、完成 cleanup 或核验 tool ledger。输入若错误地声称 passed，
Reporter 只能按现有结构规则检查，不能重新观察产品来推翻它。

Agent loop 接受 Codex rollout、SurfaceLoom trace 或第三方 adapter 输出，归一为
`surfaceloom.agent-loop/v1`，执行输入限制和脱敏，再合并/展示时间线。它按时间和显式 correlation id
组织事件；它没有 run completion/ledger completeness 合同，也不会把时间相邻当作因果，更不应修改
Reporter 或现有 execution kernel 的 verdict。

因此当前两者都是已测试的“结果消费者/视图”能力，不是 runner、Agent fixture、side-effect probe
或最终判定引擎。
