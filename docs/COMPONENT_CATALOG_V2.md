# SurfaceLoom V2 组件目录

> 状态：目标组件库。组件分为普通桌面、系统表面和 Agent 扩展三个包；产品只组合自己需要的组件。

## 1. 组件设计原则

- 一个组件对应一个稳定的用户交互边界，不对应某个具体控件类。
- 组件暴露动作和断言；场景不直接 find、click、press key 或操作进程。
- 通用组件不保存产品文案。产品适配器注入定位器和 AppBehaviorPolicy。
- 每个动作声明 side effect；runner 在调用前执行门禁。
- 每个组件声明 capability 与 fixture；不支持的平台返回明确的 notApplicable/unsupported。
- 同一组件可以有平台实现，但保持语义和诊断一致。
- P0 表示建立框架时必须优先完成；P1 表示常见产品需要；P2 表示按产品需求接入。

## 2. 普通桌面组件包

包名建议：desktop

| 组件 | 优先级 | 核心动作与断言 | 跨平台注意 |
|---|---:|---|---|
| AppLifecycleComponent | P0 | launch、requestQuit、waitExited、reopen；断言进程所有权与无残留 | macOS Cmd+Q；Windows Exit/最后窗口/托盘策略 |
| WindowComponent | P0 | focus、close、minimize、maximize、restore、moveToFront；断言标题/数量/状态 | hide 不是 Windows 通用语义 |
| MenuCommandComponent | P0 | openMenu、invokeCommand、requireEnabled/Checked | macOS 全局 menu bar；Windows window menu/hamburger |
| DialogComponent | P0 | requirePresented、confirm、cancel、waitDismissed | sheet、modal、top-level dialog 都要建模 |
| AlertComponent | P0 | 读取标题/正文/按钮，选择安全动作 | 系统安全弹窗由 system 包处理 |
| TextInputComponent | P0 | focus、replace、append、clear；断言 value/placeholder/error | RichEdit/IME 可能要求真实输入 |
| NavigationComponent | P0 | openDestination、goBack、requireSelected | sidebar、navigation view、source list |
| CollectionComponent | P0 | row/item 查找、选择、展开、排序断言 | list/table/tree/virtualized list 用策略配置 |
| ToolbarComponent | P0 | invokeItem、requireItem、overflow | Windows command bar 与 macOS toolbar 不同 |
| TabComponent | P0 | open、select、close、reorder 断言 | document tabs 与 setting tabs 分策略 |
| SearchComponent | P0 | query、clear、waitResults、requireEmpty | debounce 与 async completion 在组件等待 |
| ShortcutComponent | P0 | performSemanticShortcut、requireResult | 场景不出现 Cmd/Alt/virtual key |
| ContextMenuComponent | P1 | openForItem、invoke、dismiss | 真实右键输入可能需要 interactive desktop |
| FormComponent | P1 | fillFields、submit、requireValidation | 组合 TextInput/Choice，不接管产品提交语义 |
| ChoiceComponent | P1 | select checkbox/radio/combo，断言状态 | UIA Pattern 与 AX role 可不同 |
| SettingsComponent | P1 | openSection、changeReversible、restore | 产品适配器提供 section map |
| CommandPaletteComponent | P1 | open、searchCommand、invoke、dismiss | Electron/IDE/Agent 常见 |
| ToastBannerComponent | P1 | waitMessage、requireSeverity、dismiss | 只表示 App 内提示 |
| ProgressComponent | P1 | waitStarted/Completed、requirePercent、cancel | determinate/indeterminate 区分 |
| ClipboardComponent | P1 | copy、paste、requireContent、restore | 必须备份并恢复用户剪贴板 |
| DragDropComponent | P1 | dragItemToTarget、requireOrder | 注入输入；固定窗口与 DPI 前置 |
| MultiWindowComponent | P1 | newWindow、switch、closeOne、requireIsolation | 多进程 Electron 不能只按 PID |
| SplitViewComponent | P2 | resize、collapse、requirePane | 尺寸断言使用容差 |
| WebViewComponent | P2 | requireLoaded、bridgeToBrowserBackend | 不把 DOM selector 混入原生组件 |
| MediaComponent | P2 | play、pause、seek、requireState | 系统媒体权限另行门禁 |
| UpdateComponent | P2 | requireUpdateAvailable、defer、restart | 安装/替换 App 属高副作用 |
| AuthComponent | P2 | 展示登录入口、取消、错误态 | 真登录使用 sandbox；系统浏览器转 system 包 |
| AccessibilityAuditComponent | P2 | requiredName/role/focus/order 检查 | 作为质量扫描，不代替行为断言 |

`WebViewComponent` 的 manifest 已以 `desktop.common.web-view` 落地；DOM backend、定位器和使用方式
见 [Playwright 浏览器后端](PLAYWRIGHT.md)。组件本身保持产品与浏览器实现无关。

### 普通桌面 P0 最小集合

首个跨平台版本优先落地 12 个：

1. AppLifecycleComponent
2. WindowComponent
3. MenuCommandComponent
4. DialogComponent
5. AlertComponent
6. TextInputComponent
7. NavigationComponent
8. CollectionComponent
9. ToolbarComponent
10. TabComponent
11. SearchComponent
12. ShortcutComponent

这组足以覆盖编辑器、聊天、设置、工具类、Electron 客户端和常规 CRUD 桌面应用的 smoke 路径。

## 3. 系统表面组件包

包名建议：system

| 组件 | 优先级 | 核心动作与断言 | 安全/平台说明 |
|---|---:|---|---|
| FileOpenSaveComponent | P0 | waitOpen/Save、setFixturePath、select、cancel、dismiss | 默认只跑 Cancel；Select/Save 需临时目录 |
| SystemAlertComponent | P0 | 识别 owner、正文、按钮；安全取消 | 不自动接受 securitySensitive 动作 |
| PermissionPromptComponent | P0 | requireRequested、requirePurpose、deny/checkpoint | macOS TCC、Windows privacy/UAC；禁止自动 Allow |
| StatusSurfaceComponent | P0 | requireIcon、openMenu、restoreApp、quit | macOS menu bar extra；Windows tray |
| DockTaskbarComponent | P1 | requireRunning、activate、requireWindowState | 不 pin/unpin 用户项目 |
| SystemNotificationComponent | P1 | waitNotification、open、dismiss | macOS Notification Center / Windows toast |
| FileSystemRevealComponent | P1 | revealFixtureItem、requireSelection | Finder/Explorer；仅 fixture 路径 |
| DefaultAppChooserComponent | P1 | requireChooser、cancel | 改默认 App 属 securitySensitive/writesLocal |
| BrowserAuthComponent | P1 | waitRedirect、cancel、returnToApp | OAuth 使用 sandbox identity |
| ShareSheetComponent | P2 | requireTargets、cancel | macOS share sheet / Windows share UI |
| PrintDialogComponent | P2 | requirePreview、cancel | 禁止向真实打印机提交 |
| ColorFontPanelComponent | P2 | open、chooseFixtureValue、cancel | 平台原生面板差异大 |
| InstallerComponent | P2 | inspectSignature、launchInstaller、checkpoint | 安装与提升权限单独 RC lane |
| ProtocolHandlerComponent | P2 | openTestURL、requireRouting | 使用测试 scheme 与 fixture payload |
| CrashReporterComponent | P2 | detectCrashUI、collectReport、dismiss | 不上传真实日志 |
| ScreenCapturePickerComponent | P2 | requireSources、cancel | 屏幕录制权限 securitySensitive |
| CameraMicrophonePickerComponent | P2 | requirePreview/denial state | 不自动授予隐私权限 |

### System P0

1. FileOpenSaveComponent
2. SystemAlertComponent
3. PermissionPromptComponent
4. StatusSurfaceComponent

它们是最容易被普通 UI 框架漏掉、但对原生客户端发布最关键的边界。

## 4. Agent 扩展组件包

包名建议：agent

Agent 包依赖 desktop/system 包，不反向污染普通桌面组件。

| 组件 | 优先级 | 核心动作与断言 | Fixture/副作用 |
|---|---:|---|---|
| ConversationNavigationComponent | P0 | new、select、rename UI、requireActive | seeded conversations；rename 为 writesLocal |
| ComposerComponent | P0 | typePrompt、clear、submit、cancel | submit 默认只连 fake model |
| StreamingResponseComponent | P0 | waitStarted、requireDelta、waitCompleted、cancel | deterministic token stream |
| RunStatusComponent | P0 | requireQueued/Running/Done/Failed、waitTransition | fake clock/event source |
| ToolCallComponent | P0 | requireTool/Args/Result、expand、retry | fake tool server |
| ApprovalComponent | P0 | requirePending、approve、reject、rememberChoice | approve 可是 externalEffect；默认 fake |
| PermissionModeComponent | P0 | requireMode、changeMode、requireScope | 修改真实权限模式禁止 existing |
| AttachmentComponent | P0 | openPicker、cancel、requireChip、remove | 只选 fixture 文件 |
| AgentComputerControlComponent | P0 | requireIdle/Active、requestStop、requireStopped | 测客户端控制面，不是 Computer Use driver |
| EmergencyStopComponent | P0 | requireReachable、stop、requireNoFurtherAction | 必须高优先且无需滚动深找 |
| SessionRecoveryComponent | P0 | simulateRestart、restoreRun、requireNoDuplicate | seeded checkpoint |
| ErrorRecoveryComponent | P0 | requireError、retry、cancel、copyDiagnostic | 注入确定性失败 |
| ModelPickerComponent | P1 | open、selectFixtureModel、requireSelected | 禁止依赖线上随机模型列表 |
| PlanComponent | P1 | requireSteps、expand、requireProgress | fake plan events |
| SubagentComponent | P1 | requireSpawned、select、requireCompletion | deterministic subagent fixture |
| HandoffComponent | P1 | requireTarget、handoff、requireOwnership | fake target；真实发送 externalEffect |
| TerminalComponent | P1 | requireCommand、cancel、copyOutput | 默认 sandbox 工作目录 |
| CodeDiffComponent | P1 | requireFiles/Hunks、accept/reject | accept 为 writesLocal，仅 fixture repo |
| ArtifactComponent | P1 | requireArtifact、preview、downloadFixture | 下载只到临时目录 |
| ConnectorComponent | P1 | list、connectCheckpoint、disconnectSandbox | OAuth/真实连接 securitySensitive |
| ContextMeterComponent | P1 | requireUsage、warning、compaction state | 使用固定 context fixture |
| CitationComponent | P1 | requireCitation、openPreview | 禁止访问真实私有链接 |
| VoiceInputComponent | P2 | start、stop、requireTranscript | 麦克风权限与音频 fixture |
| ScheduleComponent | P2 | createSandboxSchedule、cancel | 真实自动化任务 externalEffect |
| MemoryComponent | P2 | propose、acceptSandbox、deleteSandbox | 真实记忆写入 externalEffect |
| MCPServerComponent | P2 | requireServer/Tool、reconnect、error state | local fake MCP server |
| CostUsageComponent | P2 | requireEstimate/Limit/Warning | 固定账单 fixture |
| OfflineModeComponent | P2 | simulateOffline、requireQueue、recover | network fault fixture |
| SyncConflictComponent | P2 | injectConflict、resolveSandbox | seeded local/remote state |

### Agent P0

首批建议 12 个：

1. ConversationNavigationComponent
2. ComposerComponent
3. StreamingResponseComponent
4. RunStatusComponent
5. ToolCallComponent
6. ApprovalComponent
7. PermissionModeComponent
8. AttachmentComponent
9. AgentComputerControlComponent
10. EmergencyStopComponent
11. SessionRecoveryComponent
12. ErrorRecoveryComponent

### AgentComputerControl 与 Computer Use 的边界

AgentComputerControlComponent 只验证客户端里与 Computer Use 相关的产品 UI：

- 当前是否运行。
- 目标或会话摘要是否正确。
- Stop/Emergency Stop 是否可达。
- 停止后是否不再产生动作。
- 权限不足或系统阻止时是否显示正确状态。

它不负责看屏幕、理解 UI 或替代 AX/UIA driver。真正的 Computer Use backend 属于 exploratory driver，可用来发现页面或辅助复现，但不应成为 P0 回归断言的唯一依据。

## 5. 组件 Manifest

当前 manifest 结构示例：

    id: desktop.agent.tool-call
    name: Tool Call
    summary: Observes agent tool calls and their deterministic result state.
    kind: agent
    version: 1.0.0
    platforms: [macos, windows]
    requiredCapabilities: [ui.inspect, ui.wait]
    requiredFixtures:
      - agent.tool-fixture
      - agent.side-effect-probe
    sideEffectLevel: externalEffect
    actions:
      - name: expand
        sideEffectLevel: reversible
      - name: retry
        sideEffectLevel: externalEffect
    assertions: [toolWasCalled, argumentsMatch, statusEquals, resultIsShown]
    locatorKeys: [toolCall.item, toolCall.status, toolCall.result]

Manifest 供三类消费者使用：

- runner：capability negotiation、fixture 创建和 side effect gate。
- 开发 Agent：判断 UI 改动需要修改哪个组件与哪些测试。
- CI：建立 semantic id 到场景、平台和发布门禁的影响图。

## 6. 场景写法

场景只描述语义：

    testCase({
      id: "agent.stop-computer-control",
      fixture: "agent.input-event-probe",
      sideEffectCeiling: "reversible",
      platforms: ["macos", "windows"],
      run: async app => {
        await app.computerControl.requireActive()
        await app.emergencyStop.stop()
        await app.computerControl.requireStopped()
      }
    })

场景中禁止出现：

- AXButton、ControlType.Button、AutomationId 或 AXIdentifier。
- Cmd+Q、Alt+F4、virtual key code。
- click(x, y) 或屏幕坐标。
- 固定 sleep。
- 直接 kill process。
- 自动接受 TCC/UAC/系统隐私开关。

## 7. Fixture 目录

当前机器可读目录在 `packages/component-catalog/src/fixtures.ts`；这些 id 已被组件 manifest
引用，产品 adapter 通过 Core `FixtureRegistry` 提供可执行 setup：

| Fixture | 组件 | 内容 |
|---|---|---|
| desktop.filesystem-sandbox | attachment/artifact | 测试拥有并清理的临时文件树 |
| agent.scripted-run | streaming/task/emergency stop | 固定 run 事件、token 与结束时机 |
| agent.tool-fixture | tool/approval | worker 级 fake tool service，按 test 隔离 namespace |
| agent.side-effect-probe | tool/approval/emergency/terminal | 记录调用次数，验证 at-most-once 与停止后零新增 |
| agent.input-event-probe | computer control | 模拟输入事件源与停止观察账本 |
| agent.recovery-state | session recovery | 隔离 profile 内的版本化中断 checkpoint |
| agent.command-fixture | terminal | 固定输出、退出码与取消行为的 sandbox executor |

后续普通桌面与 System Surface fixture 仍按需求加入。fixture 需要版本号、创建器、清理器和
允许的 side effect ceiling；fixture 数据变化也应触发相关场景。

## 8. 开发 Agent 如何配套改测试

### 8.1 决策表

| 产品改动 | 测试改动 |
|---|---|
| 文案、AutomationId、AXIdentifier、role/control type 变化 | 只改产品适配器的 locator map，并跑组件聚焦测试 |
| 同一页面新增动作 | 在现有组件添加语义 action/assertion，更新 manifest |
| 新页面或新的交互边界 | 新建组件，声明 pack/capability/fixture/side effect |
| macOS/Windows 行为不同但意图相同 | 在平台 strategy 实现差异，不复制场景 |
| 某平台没有该能力 | manifest 标 notApplicable 并给出理由 |
| 新外部写入 | 增加 fake fixture；真实 sandbox test 单独门禁 |
| 权限、窗口、退出、文件面板变化 | 同时更新 RC native case |
| UI 变更但验收行为不变 | 至少跑受影响 component/scenario，不为绿灯弱化断言 |

### 8.2 推荐步骤

1. 检查组件 catalog 与 manifest，先复用。
2. 用 AX Inspector、Accessibility Insights、winapp inspect 等只读工具确认可访问属性。
3. 优先给产品控件补稳定 identifier。
4. 修改产品 locator map 或组件语义方法。
5. 声明 action 的 side effect 与所需 fixture。
6. 补一个行为断言，避免只断言“元素存在”。
7. 跑 contract、backend conformance 和组件聚焦测试。
8. 跑受影响产品场景的 macOS/Windows matrix。
9. 确认 teardown、进程、临时目录和外部 fake call 无残留。
10. 将 fallback 命中、skip 和 notApplicable 作为可审计结果。

### 8.3 Definition of Done

UI 功能改动只有同时满足以下条件才算完成：

- 产品代码提供稳定的可访问名称与 identifier。
- 受影响 semantic id 已声明。
- 组件 action/assertion 与 manifest 同步。
- 至少有一个正向行为断言；错误/取消路径按风险补充。
- side effect 没有被降级，existing profile 没有写入。
- macOS 与 Windows 都执行，或缺失平台有明确 notApplicable。
- 系统边界改动进入 RC native lane。
- 失败诊断足以让下一位开发 Agent 不靠肉眼重跑也能定位。

## 9. 防止组件膨胀

不要创建 ButtonComponent、LabelComponent、GenericClickComponent 之类只包装原始 API 的公共组件。它们不会稳定测试语义，反而让场景重新依赖 UI 结构。

可以存在内部 primitive：

- ElementQuery
- WaitCondition
- InvokeAction
- ValueAction
- WindowScope
- DiagnosticCollector

这些 primitive 只供组件实现使用，不暴露给产品场景。

新增组件前回答三个问题：

1. 它是否拥有独立的用户意图和状态机？
2. 它是否能隐藏一组定位、等待或平台差异？
3. 两个以上产品是否可能复用，或者它是否明确属于 product adapter？

若三个答案都是否，应给现有组件增加方法，而不是扩充类数量。

## 10. 落地顺序

### M0：框架底座

- AppLifecycle、Window、MenuCommand、Dialog、Alert
- FileOpenSave、SystemAlert、PermissionPrompt
- component manifest、fixture、side effect gate、诊断包

### M1：普通桌面

- TextInput、Navigation、Collection、Toolbar、Tab、Search、Shortcut
- macOS 与 Windows sample app conformance

### M2：Agent 核心

- Conversation、Composer、Streaming、RunStatus
- ToolCall、Approval、PermissionMode、Attachment
- AgentComputerControl、EmergencyStop、Recovery

### M3：平台系统面

- macOS XCUITest RC：Cmd+W、Cmd+Q、TCC、文件面板、菜单/窗口
- Windows RC：Alt+F4/Exit/tray、Common Item Dialog、UAC 可见性、系统通知

### M4：扩展

- Settings、CommandPalette、Clipboard、DragDrop、MultiWindow
- Plan、Subagent、Terminal、Diff、Artifact、Connector、Offline
