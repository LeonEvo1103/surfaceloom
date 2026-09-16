# SurfaceLoom 能力事实矩阵

> 审计任务：`SL-P0-010`
>
> 审计 revision：`aebb24c32f3dec0e7b51c369656cd2d27430dabb`
>
> 审计日期：2026-09-16

本文只记录上述 revision 中可由源码和测试证明的能力。规划中的 execution kernel、跨语言协议、
TypeScript native client、macOS stdio host、中性 native fixture App 和 fluent SDK 不计为已实现。

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
| CaseSpec 语义合同 | [`case-spec.ts`](../../packages/core/src/case-spec.ts) | [`case-spec.test.ts`](../../packages/core/tests/case-spec.test.ts) | `contract-tested` | 只有 execution-independent spec；没有 CaseExecution、attempt 或 runner。 |
| native driver/session SPI | [`driver.ts`](../../packages/core/src/driver.ts) | [`core.test.ts`](../../packages/core/tests/core.test.ts) | `contract-tested` | 是 TypeScript 接口，不是 macOS/Windows 的统一原生实现；没有一个 backend 实现该接口。 |
| semantic locator/match policy | [`locator.ts`](../../packages/core/src/locator.ts) | [`core.test.ts`](../../packages/core/tests/core.test.ts) | `contract-tested` | Core locator 与 AX locator、UIA wire locator 是三套形状，尚无跨语言映射。 |
| guarded element action | [`guarded-actions.ts`](../../packages/core/src/guarded-actions.ts) | [`actionability.test.ts`](../../packages/core/tests/actionability.test.ts)、[`action-deadline.test.ts`](../../packages/core/tests/action-deadline.test.ts) | `contract-tested` | fake backend 验证 precheck 与单次 dispatch；没有原生 bridge，也没有 `executed/unknown/notExecuted` outcome。超时不取消底层 resolver。 |
| fixture lifecycle/registry | [`fixture-runtime.ts`](../../packages/core/src/fixture-runtime.ts)、[`fixture-registry.ts`](../../packages/core/src/fixture-registry.ts) | [`fixture.test.ts`](../../packages/core/tests/fixture.test.ts) | `contract-tested` | 支持 test/worker scope、按需 setup、逆序 teardown；没有 Case deadline、跨进程 lease 或强制取消。 |
| doctor schema/summary | [`doctor.ts`](../../packages/core/src/doctor.ts) | [`runtime.test.ts`](../../packages/core/tests/runtime.test.ts) | `contract-tested` | 只解析/汇总报告；平台 doctor 仍各自实现。 |
| Core trace recorder | [`trace.ts`](../../packages/core/src/trace.ts) | [`runtime.test.ts`](../../packages/core/tests/runtime.test.ts) | `contract-tested` | 内存事件与脱敏；不是持久化 trace、Case verdict 或跨 surface 因果模型。 |
| component/fixture catalog | [`catalog.ts`](../../packages/component-catalog/src/catalog.ts)、[`fixtures.ts`](../../packages/component-catalog/src/fixtures.ts) | [`catalog.test.ts`](../../packages/component-catalog/tests/catalog.test.ts) | `contract-tested`（仅目录数据） | 测试证明 37 个 manifest 和 7 个 fixture metadata 自洽，不证明对应行为或 fixture setup 可执行。 |
| browser backend | [`backend.ts`](../../packages/browser-playwright/src/backend.ts)、[`session.ts`](../../packages/browser-playwright/src/session.ts) | [`backend.test.ts`](../../packages/browser-playwright/tests/backend.test.ts)、[`session.test.ts`](../../packages/browser-playwright/tests/session.test.ts) | `contract-tested` | 默认套件使用 fake Playwright。真实 Chrome smoke 受环境变量门禁，见第 4 节。 |
| macOS backend | [`SurfaceLoomMacOS`](../../Sources/SurfaceLoomMacOS) | [`SurfaceLoomMacOSTests`](../../Tests/SurfaceLoomMacOSTests) | `contract-tested` | Swift library 直接提供 AX/AppKit/CGEvent API；没有中性 fixture conformance、stdio host 或 TS bridge。 |
| Windows backend | [`SurfaceLoom.WindowsHost`](../../native/windows-host/src/SurfaceLoom.WindowsHost) | [`SurfaceLoom.WindowsHost.ContractTests`](../../native/windows-host/tests/SurfaceLoom.WindowsHost.ContractTests) | `contract-tested` | .NET NDJSON 0.2 host；没有中性 fixture App、Windows live conformance 或 TS client。 |
| report/v2 | [`model.ts`](../../packages/reporter/src/model.ts)、[`write-report.ts`](../../packages/reporter/src/write-report.ts) | [`report-validation.contract.test.ts`](../../packages/reporter/tests/report-validation.contract.test.ts)、[`reporter.test.ts`](../../packages/reporter/tests/reporter.test.ts) | `contract-tested` | 校验/归档/派生 HTML 和 Markdown；不执行 Case、不采集 UI、不决定 runner cleanup。单 run 只有一个 `platform`，没有 surface/attempt。 |
| Agent-loop trace | [`adapter.ts`](../../packages/agent-loop/src/adapter.ts)、[`merge.ts`](../../packages/agent-loop/src/merge.ts) | [`adapters.test.ts`](../../packages/agent-loop/tests/adapters.test.ts)、[`merge-render.test.ts`](../../packages/agent-loop/tests/merge-render.test.ts) | `contract-tested` | 导入、脱敏、合并和静态展示；不运行 Agent、不证明 ledger completeness、不产生 authoritative verdict。 |
| execution kernel / `sl test` | — | — | — | `@surfaceloom/test` 尚不存在。 |
| native TS client / shared wire conformance | — | — | — | `@surfaceloom/native`、共享 schema/golden vectors 尚不存在。 |

## 3. Core capability registry 与 backend 事实

Core 在 [`capabilities.ts`](../../packages/core/src/capabilities.ts) 声明 30 个字符串。声明进入 registry
只代表可用于协商；它不保证任何 backend 已实现。以下 `CT` 表示最高只有 `contract-tested`，`D` 表示
最高只有 `declared`；两者都不是 live 证据。每一行的声明源码均为上述 registry；registry/协商 helper
的测试入口是 [`core.test.ts`](../../packages/core/tests/core.test.ts)，平台行为的源码和测试入口列在表后。

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
`npm run test:local` 入口设置该变量。本 revision 没有一份随仓库保存的执行记录，所以事实矩阵保持
`contract-tested`；只有实际运行且记录 executed/skipped/evidence 后，相关 browser 项才能升级为
`live-fixture-tested`。这些中性 fixture 也不是产品 adapter，因此不能升级为 `target-app-tested`。

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
| `desktop.agent.tool-call` | — | `declared` | 没有 tool ledger/runtime。 |
| `desktop.agent.approval` | — | `declared` | 没有 approval fixture、adapter 或 Case。 |
| `desktop.agent.permission-mode` | — | `declared` | 只有 manifest。 |
| `desktop.agent.task-run` | — | `declared` | 没有 run completion barrier。 |
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

- [`Package.swift`](../../Package.swift) 只发布 `SurfaceLoomMacOS` Swift library。
- AX locator、ownership、轮询、动作和 UI-state recovery 都直接作为 Swift API；测试集中在纯合同、
  临时文件和失败路径，没有仓库控制的 GUI fixture App。
- 没有 stdio/NDJSON host、protocol version、跨语言 error/action result、TS client 或 golden vectors。

### Windows

- [`HostProtocol.cs`](../../native/windows-host/src/SurfaceLoom.WindowsHost/Protocol/HostProtocol.cs) 固定为
  NDJSON `0.2`，方法包含 handshake/doctor/capabilities、session lifecycle、element query/action。
- [`AutomationContracts.cs`](../../native/windows-host/src/SurfaceLoom.WindowsHost/Protocol/AutomationContracts.cs)
  定义 UIA locator、session ownership、element snapshot 和 action；
  [`RequestDispatcher.cs`](../../native/windows-host/src/SurfaceLoom.WindowsHost/Host/RequestDispatcher.cs)
  在单进程内路由请求。
- 合同可执行程序覆盖 38 个协议/安全 client 检查，但没有中性 GUI fixture 的 launch → find → action →
  postcondition 纵向测试，故仍是 `contract-tested`。
- `element.action` 成功返回 snapshot，失败返回 error；协议没有可信 receipt，也没有标准化
  `notExecuted/executed/unknown`。因此断线后不能从现有 wire 证明动作是否已经提交，更不能自动重试。
- host feature 名称（例如 `uia.semanticActions`）不是 Core capability registry 的直接实现声明；当前没有
  TypeScript transport/client 把二者映射起来。Windows 0.2 也不是已冻结的跨平台协议。

结论：当前跨平台共用的是部分设计词汇和目录数据，不是一条 `TypeScript → shared protocol → native`
的可执行链路。

## 7. Reporter 与 Agent loop 的权威边界

Reporter 接受调用方提供的 `CaseSpec + result`，校验状态/验收项关联，按 policy 复制证据，并从
`report.json` 确定性生成 HTML/AI Markdown。其测试证明 schema、脱敏、路径与制品处理；没有代码负责
执行动作、等待 assertion、创建 fixture、完成 cleanup 或核验 tool ledger。输入若错误地声称 passed，
Reporter 只能按现有结构规则检查，不能重新观察产品来推翻它。

Agent loop 接受 Codex rollout、SurfaceLoom trace 或第三方 adapter 输出，归一为
`surfaceloom.agent-loop/v1`，执行输入限制和脱敏，再合并/展示时间线。它按时间和显式 correlation id
组织事件；它没有 run completion/ledger completeness 合同，也不会把时间相邻当作因果，更不应修改
Reporter 或未来 execution kernel 的 verdict。

因此当前两者都是已测试的“结果消费者/视图”能力，不是 runner、Agent fixture、side-effect probe
或最终判定引擎。
