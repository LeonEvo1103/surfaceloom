# SurfaceLoom V2 架构

> 状态：首个跨平台骨架已落地。TypeScript 契约/组件 manifest、Swift macOS backend、
> C# Windows UIA host、可选 Playwright DOM backend 与独立产品适配器均已有代码；fixture app、双平台 conformance 和
> 完整组件实现仍按本文路线增量建设。

> 框架 execution kernel、任务状态、阶段门槛和验收证据以 [Framework SSOT](FRAMEWORK_SSOT.md)
> 为准；当前实现级别以[能力事实矩阵](framework/capabilities.md)为准。本文描述长期分层，示例中的
> 目标接口不代表各 backend 已实现；如旧阶段文字与 SSOT 冲突，以 SSOT 为准并同步修正文档。

## 1. 决策摘要

SurfaceLoom 不绑定某个产品，也不把 macOS 或 Windows 的原生 API 暴露给场景测试。动作执行栈分为五层：

1. **场景层**表达用户意图与验收结果。
2. **产品适配层**描述一个具体 App 的入口、能力、文案和定位器。
3. **语义组件层**提供窗口、菜单、文件面板、会话、工具审批等稳定行为。
4. **驱动契约层**定义跨平台动作、查询、等待和诊断协议。
5. **原生后端层**当前分别使用 macOS AX/AppKit/CGEvent 和 Windows UIA/Win32。
   XCUITest 是后续发布候选专用测试层，不是现有日常 backend。

测试框架的中心是可嵌入的 **CaseExecution kernel**：它负责 Case 生命周期、fixture、step、
criterion、deadline、策略、证据和清理语义；browser、desktop、system 和 Agent probe 向它提供
类型化能力。它不把 DOM click、AXPress、UIA Invoke 和真实鼠标注入伪装成同一个动作。
该 kernel 按 SSOT 原子任务增量落地，未标记 `done` 的部分仍是设计契约。

横切的 **Agent loop pipeline** 通过可插拔 TraceAdapter 归一模型、工具、审批、桌面和浏览器
事件；它消费各层 trace，但不进入动作调用链。viewer 只依赖通用 schema，不依赖具体 runtime。

依赖只能向下：

    Scenario
       |
       v
    Product Adapter -----> Component Packs
                               |
                               v
                         DesktopDriver Contract
                            /             \
                           v               v
                   macOS Backend      Windows Backend
               AX / AppKit / CGEvent  UIA / Win32

    Product Adapter -----> WebView Component
                               |
                               v
                     BrowserSession Contract
                               |
                               v
                     Playwright Core Backend

关键约束：

- 场景与通用组件不能 import ApplicationServices、XCTest、FlaUI 或 Windows UIA 类型。
- 产品文案、bundle id、exe 路径、AutomationId 和 AXIdentifier 只能进入产品适配层。
- 快捷键不是业务语义。场景调用 closeWindow、hideApplication、quitApplication，产品适配器声明各平台如何实现。
- Computer Use 是可插拔的探索/操作后端，不是回归测试的基础组件。Agent 客户端里“Computer Use 运行状态、停止、授权提示”属于 Agent 组件包。
- 发布门禁以确定性的 AX/UIA 测试为主；Computer Use 可用于探索、生成候选定位器和失败复现。

## 2. 当前目录

    packages/core/                  TypeScript 跨平台语义契约
    packages/browser-playwright/    可选 Playwright DOM backend
    packages/agent-loop/            通用 Agent loop schema、adapter 与 viewer
    packages/component-catalog/     机器可读组件 manifest
    packages/reporter/              结果 schema、证据归档与 AI/HTML 报告
    packages/native/                共享 native wire schema、framing 与 golden vectors
    packages/test/                  可嵌入 execution kernel 与 CLI
    Sources/SurfaceLoomMacOS/    Swift + AX/AppKit backend
    native/windows-host/            .NET + Windows UI Automation host
    projects/                       可选产品适配器接入约定
    Tests/SurfaceLoomMacOSTests/ macOS backend contract
    docs/                            架构与平台说明

后续再增加 macOS/Windows fixture app、共享 conformance、Appium bridge 和发布候选专用的
XCUITest/system-surface suites。目录可以演进，但层间依赖方向不可反转。

Reporter 是横切消费者，不在 Scenario → Component → Core → backend 的动作依赖链中。平台
backend/runner 产生截图、录屏、trace 和诊断，Reporter 只归档并生成视图，不能反向调用组件或
操作产品 UI。

## 3. 驱动契约

驱动契约是跨语言、可版本化的数据协议。TypeScript SDK 面向场景作者；当前 Windows
.NET host 使用本地 stdio NDJSON，Swift/macOS backend 先保留直接 API，待 conformance
稳定后再增加相同 sidecar 协议。默认不启动常驻高权限服务。

目标驱动契约如下。TypeScript Core 已定义这些语义；各原生 backend 仍按 capability 渐进实现，
不能仅凭接口存在就宣称平台已经支持：

    interface DesktopDriver {
      launch(app, fixture): Session
      attach(app, policy): Session
      terminate(session, policy): void

      listWindows(scope): WindowRef[]
      find(locator, scope): ElementRef
      findAll(locator, scope): ElementRef[]

      actions.invoke(element): void
      focus(element): void
      actions.setValue(element, value): void
      actions.typeText(target, text): void
      performShortcut(shortcut): void

      waitFor(condition, timeout): Observation
      screenshot(scope): Artifact
      snapshotAccessibility(scope): Artifact
      collectDiagnostics(reason): DiagnosticBundle
    }

ElementRef 只在所属 session 和有限时间内有效。组件不得把原生 AXUIElement、AutomationElement、HWND 或坐标泄漏到场景层。

`session.actions` 是强制守卫层：先按动作解析 attached、unique、visible、enabled 等
actionability 条件，再向原生 backend 提交一次动作。轮询和重试只允许发生在解析阶段，
`performResolvedAction` 不自动重放，避免点击、输入、审批等副作用执行两次。组件不直接
持有原生动作 backend。resolved element id 归所属 session/backend 所有；后端必须拒绝
跨 session、stale 或未知引用。并发动作不承诺调用顺序，存在依赖的场景必须逐个 `await`。

每个后端启动时返回 capability 集合。当前规范名称例如：

- ui.inspect
- ui.invoke
- ui.set-value
- ui.wait
- keyboard.inject
- window.inspect
- window.manage
- screenshot.capture
- browser.navigate
- browser.dom.inspect
- browser.dom.invoke
- browser.trace
- system.open-save-panel
- system.notification.inspect

组件先声明所需 capability；runner 在执行前 fail fast，而不是运行到一半才发现平台不支持。

## 4. App 描述与产品适配

一个产品由 DesktopAppDescriptor 描述：

    id: sample.editor
    displayName: Sample Editor
    platforms:
      macos:
        bundleId: com.example.editor
        appPath: /Applications/Sample Editor.app
        processName: Sample Editor
      windows:
        executable: C:\Program Files\Sample Editor\Editor.exe
        processName: Editor
        packageFamilyName: optional
    capabilities:
      - multipleWindows
      - nativeFileDialog
      - trayMode

产品适配层负责：

- 提供 app 标识、启动方式、进程所有权和退出判定。
- 为通用组件注入产品定位器与行为策略。
- 组合产品拥有的 desktop、system、agent 组件。
- 隐藏本地化文案、平台控件差异和兼容 fallback。
- 声明产品是否支持“关闭最后窗口仍驻留”“最小化到托盘”等策略。

产品适配层不负责：

- 实现 AX/UIA 遍历。
- 直接接受屏幕坐标作为稳定定位器。
- 绕过 fixture 或副作用门禁。
- 将产品专属逻辑塞回通用组件。

## 5. 定位器模型

跨平台 Locator 是一个语义键加平台候选，不是强行把 AXRole 和 UIA ControlType 合成同一个枚举：

    semanticName: settings.open
    macos:
      identifiers: [settings-button]
      roles: [AXButton]
      labels: [Settings, 设置]
    windows:
      automationIds: [SettingsButton]
      controlTypes: [Button]
      names: [Settings, 设置]
    fallbackPolicy: stable-only

稳定性优先级：

1. 开发者维护的 AXIdentifier / AutomationId。
2. 在稳定容器中组合角色或 ControlType 与可访问名称。
3. 受组件约束的层级关系。
4. 本地化文案候选。
5. 短期兼容 fallback。

禁止把坐标、数组下标、完整 XPath、UIA RuntimeId 或临时语义 slug 当作长期契约。fallback 每次命中都应写入诊断，便于开发者补回稳定标识。

网页内容使用 browser package 自己的 `DomLocator`，不扩充或复用原生 `Locator`。DOM 首选 role、
label、testId 和稳定文本，CSS 只作为产品 adapter escape hatch。Playwright 的 Page、Locator、
BrowserContext 等运行时对象不得进入 Core、组件 manifest 或产品场景的公共契约。

## 6. 组件与 Manifest

组件按语义边界组织，而不是按每个 Button、TextField 建类。每个组件有机器可读 manifest，供开发 Agent 查询和架构检查：

    id: desktop.agent.approval
    name: Agent Approval
    summary: Handles explicit user approval gates around agent actions.
    kind: agent
    version: 1.0.0
    platforms: [macos, windows]
    requiredCapabilities: [ui.inspect, ui.invoke, ui.wait]
    requiredFixtures: [agent.tool-fixture, agent.side-effect-probe]
    sideEffectLevel: externalEffect
    actions:
      - name: approveOnce
        sideEffectLevel: externalEffect
      - name: deny
        sideEffectLevel: reversible
    assertions: [isRequested, scopeEquals, riskTextIsShown]
    locatorKeys: [approval.prompt, approval.allowOnce, approval.deny]

Manifest 至少包含：

- 唯一 id、kind、版本与支持平台。
- actions、assertions 和每个动作的副作用等级。
- 所需 driver capability。
- 所需 fixture 与 locator key。

允许的 profile、optional capability 和逐 backend 验证状态仍属于后续 schema 演进项，
不能把它们当成当前 manifest 已有字段。

组件目录设计见 COMPONENT_CATALOG_V2.md；框架阶段和任务状态只在 FRAMEWORK_SSOT.md 维护。

## 7. Fixture 与副作用门禁

### 7.1 Fixture profile

| Profile | 用途 | 数据规则 | 默认行为 |
|---|---|---|---|
| ephemeral | 生命周期、窗口、菜单、空状态 | 每次创建临时目录 | 默认 |
| seeded | 列表、历史、Agent 工具与审批 | 只加载版本化种子数据 | 允许本地可逆修改 |
| existing | 依赖真实登录态的只读观察 | 不复制、不清空、不接管 | 必须显式授权 |
| external-sandbox | 必须验证外部写入的少量测试 | 专用测试账号与命名空间 | 单独门禁、默认关闭 |

runner 只能终止自己启动的进程。发现目标 App 已运行时默认拒绝接管；attach 必须在场景元数据和命令行上双重开启。

### 7.2 Side effect level

| 等级 | 示例 | 要求 |
|---|---|---|
| readOnly | 读文本、检查窗口、截图 | 可在 ephemeral/seeded 执行 |
| reversible | 打开再取消面板、展开后收起 | 必须注册 teardown 与最终状态断言 |
| writesLocal | 改测试目录中的偏好、创建本地草稿 | 仅 ephemeral/seeded，禁止 existing |
| externalEffect | 发消息、上传、调用真实工具、远端删除 | 仅 external-sandbox，显式 allow flag |
| securitySensitive | 接受 TCC/UAC、改系统隐私设置、绕过 SmartScreen | 自动测试禁止执行，仅允许观察与人工 checkpoint |

门禁在动作调用前检查，而不是只依赖测试作者自觉。组件动作声明等级，场景不能降低它。

### 7.3 Agent fixture

Agent 流程默认使用确定性的 fake model/tool server：

- 固定 token 流与结束事件。
- 固定工具调用、参数和审批结果。
- 可注入超时、失败、重试和取消。
- 记录请求但不访问真实外部系统。
- 每个测试使用独立 conversation id 和工作目录。

这样可以稳定测试流式输出、工具卡片、审批、停止、恢复，而不把模型随机性当成 UI 回归噪声。

## 8. macOS 与 Windows 的职责分配

### macOS

- 日常回归后端：Swift + Accessibility API，键盘输入仅在语义动作无法完成时使用 CGEvent。
- 系统文件面板、菜单、窗口和 sheet 由 AX desktop/application scope 处理。
- XCUITest 保留给发布候选的关键原生行为：Cmd+W、Cmd+Q、系统弹窗、TCC 可见性、文件选择器和菜单/窗口集成。
- 不调用 tccutil reset，不自动同意系统隐私权限。
- 如果采用跨语言 WebDriver，Appium Mac2 可作为桥接选项；它本质仍基于 XCTest，不替代产品的 XCUITest 发布门禁。

### Windows

- 日常回归后端：当前是 .NET 8 直接封装 Windows UI Automation/Win32；Microsoft winapp
  CLI 与 FlaUI/UIA3 只作为诊断、替换或增强候选，不是现有实现。
- UIA Pattern 优先，SendInput 只处理必须产生真实键鼠事件的场景。
- Common Item Dialog、顶层窗口、托盘和任务栏以 desktop/HWND scope 处理。
- UAC secure desktop、隐私设置、SmartScreen 等安全表面只观察或人工验证，不尝试自动绕过。
- Appium/WinAppDriver 只作为已有 WebDriver 资产的兼容通道，不作为新框架的唯一基础。

详细取舍见 WINDOWS.md。

## 9. 系统语义不能强行等同

跨平台复用的是“意图”，不是按键：

| 意图 | macOS 常见实现 | Windows 常见实现 |
|---|---|---|
| closeWindow | Cmd+W | Alt+F4 或窗口 Close |
| hideApplication | Cmd+H | 无直接等价；由产品策略决定 minimize/tray |
| quitApplication | Cmd+Q / Quit menu | Exit menu、关闭最后窗口或显式进程退出 |
| openFile | NSOpenPanel | Common Item Dialog |
| appMenu | 全局菜单栏 | 窗口内 MenuBar / hamburger / command |
| statusSurface | Menu Bar Extra / Dock | Notification Area / Taskbar |
| privacyPrompt | TCC | Windows privacy/UAC/系统设置 |

因此通用组件必须接收 AppBehaviorPolicy。若产品没有某语义，应明确 unsupported 或 notApplicable，不用虚假的跨平台快捷键凑结果。

## 10. 测试分层

1. **Contract**：bundle/manifest、权限用途说明、组件 manifest 和 fixture 校验；不启动 UI。
2. **Backend conformance**：用 sample app 验证每个 driver capability 的一致语义。
3. **Component contract**：用标准 fixture 验证通用组件的动作与诊断。
4. **Product scenario**：产品适配器组合组件，验证业务验收行为。
5. **RC native**：macOS XCUITest 和 Windows 原生关键路径，覆盖系统集成边界。
6. **Exploratory Computer Use**：发现未知 UI、定位脆弱点和复现复杂问题，不阻塞确定性回归的结果判定。

失败诊断的目标产物如下。当前已落地结构化 Trace、常见敏感字段脱敏、doctor 与部分
窗口/进程信息；AX/UIA 树和截图归档仍待实现：

- App 与 OS 版本、locale、screen/session 状态。
- 当前窗口清单与进程所有权。
- AX/UIA 树快照。
- 窗口截图，必要时全屏截图。
- 最后 N 个语义动作与定位器 fallback 轨迹。
- fixture、side effect gate 和 capability negotiation 结果。

## 11. 开发 Agent 的配套改测流程

产品开发 Agent 每次修改 UI 时按以下顺序工作：

1. 从变更文件推断受影响的 semantic id，并查询组件 manifest。
2. 如果只是控件 id、角色、文案或等待条件变化，只改产品适配器或现有组件。
3. 如果新增同一页面行为，在现有组件增加语义动作和断言。
4. 只有出现新的交互边界、生命周期或系统表面时才新增组件。
5. 为新动作声明 side effect、fixture、capability 和支持平台。
6. 先跑 contract 与 backend/component 聚焦测试，再跑受影响产品场景。
7. 触及窗口、文件面板、权限、退出语义时，补充对应 RC native case。
8. 在提交前执行架构检查，拒绝场景中的原生常量、坐标、裸定位器和直接进程控制。

建议 CI 从产品改动到测试建立映射：

    changed UI source
        -> semantic ids
        -> component manifests
        -> affected scenarios
        -> platform matrix

如果产品 UI 变更但找不到任何受影响组件，CI 应提示“测试影响未声明”，由开发 Agent 明确标记 no-test-impact 或补测试。

## 12. 历史平台建设阶段

本节保留平台骨架形成过程，不再作为当前执行计划。当前 P0–P4 门槛、依赖和施工状态见
FRAMEWORK_SSOT.md，避免把这里的 Phase A–E 与 SSOT 阶段混用。

### Phase A：去产品绑定

- 通用 driver、configuration、error 和 locator 使用 SurfaceLoom 命名。
- 固定 app 路径、bundle id、退出菜单名和产品 readiness 移入产品适配器。
- 环境变量使用 DESKTOP_TEST 前缀；旧变量仅做临时兼容。

状态：已完成。共享代码和默认测试不包含产品专属标识或环境变量。

### Phase B：稳定 macOS 契约

- 建立 desktop/system 组件 P0。
- 建立 sample macOS app 和 backend conformance。
- 通过 `projects/<product>` 或独立私有仓库接入产品适配器。

状态：通用 Swift 模块、产品包拆分和基础 contract 已完成；fixture app/conformance 待补。

### Phase C：Windows MVP

- 建立 Windows sample app 或系统 Notepad smoke adapter。
- 以 .NET 8 + Windows UI Automation host 实现最小 executor；winapp CLI 可作诊断 backend。
- 覆盖 launch/window/menu/dialog/file picker/diagnostics。

状态：host 协议、UIA locator/pattern 动作与 P0 生命周期已落地；Windows 机器上的 live
conformance、文件面板专用组件和诊断产物待补。

### Phase D：Windows 长期后端

- 评估用 FlaUI/UIA3 替换或增强直接 UIA 封装。
- 用同一 conformance suite 比较 direct、winapp CLI 与可选 bridge。
- WebDriver 仅作为可选 bridge。

### Phase E：Agent 扩展

- 加入 deterministic model/tool fixture。
- 落地 composer、streaming、tool call、approval、computer-control 和 recovery P0。
- 建立普通桌面、Agent 桌面和 RC native 三条 CI lane。
