# 开源框架借鉴与吸收边界

SurfaceLoom 不以复刻某个 Web 或移动测试框架为目标。目前没有一个现成框架同时覆盖
macOS AX、Windows UIA、系统界面、普通桌面组件和 Agent 语义组件。这里采用的是独立实现、
组合成熟设计模式的路线：Playwright 提供测试执行语义，Appium 提供平台扩展模型，Robot
Framework 提供动态目录模型，WebdriverIO 提供组件组织和桌面 WebView 接入经验。

## 主要来源

- Playwright：[Page Object](https://playwright.dev/docs/pom)、
  [Fixtures](https://playwright.dev/docs/test-fixtures)、
  [Locators](https://playwright.dev/docs/locators)、
  [Auto-waiting](https://playwright.dev/docs/actionability)、
  [Assertions](https://playwright.dev/docs/test-assertions)、
  [Trace Viewer](https://playwright.dev/docs/trace-viewer)。
- Selenium：[截图 API](https://www.selenium.dev/documentation/webdriver/interactions/windows/)
  与[报告职责边界](https://www.selenium.dev/documentation/test_practices/encouraged/improved_reporting/)；
  Allure：[步骤](https://allurereport.org/docs/steps/)、[附件](https://allurereport.org/docs/attachments/)
  与 [Agent Mode](https://allurereport.org/docs/agent-mode/)。
- WebdriverIO：[Page Object](https://webdriver.io/docs/pageobjects/)、
  [Selectors](https://webdriver.io/docs/selectors/)、
  [Custom Services](https://webdriver.io/docs/customservices/)、
  [Electron](https://webdriver.io/docs/desktop-testing/electron/) 与
  [Tauri](https://webdriver.io/docs/desktop-testing/tauri/) 桌面测试。
- Appium：[Core/Driver/Plugin 架构](https://appium.io/docs/en/latest/intro/appium/)、
  [构建 Driver](https://appium.io/docs/en/latest/developing/build-drivers/)、
  [构建 Plugin](https://appium.io/docs/en/latest/developing/build-plugins/)、
  [Session Capabilities](https://appium.io/docs/en/latest/guides/caps/) 与
  [Doctor Checks](https://appium.io/docs/en/latest/developing/build-doctor-checks/)。
- Robot Framework：[动态 Library API](https://robotframework.org/robotframework/7.4.2/RobotFrameworkUserGuide.html#dynamic-library-api)、
  [Library scope](https://robotframework.org/robotframework/7.4.2/RobotFrameworkUserGuide.html#library-scope)、
  [Remote Library](https://robotframework.org/robotframework/7.4.2/RobotFrameworkUserGuide.html#remote-library-interface)
  与 [Listener API](https://robotframework.org/robotframework/7.4.2/RobotFrameworkUserGuide.html#listener-interface)。
- macOS 原生参考：[AXSwift](https://github.com/tmandry/AXSwift) 的显式 AX 错误与薄封装、
  [apple-fusion](https://github.com/ProtonMail/apple-fusion) 的 Robot/Page Object 与等待钩子、
  [Appium Mac2](https://github.com/appium/appium-mac2-driver) 的 AUT ownership、doctor 和诊断。
- Windows 原生参考：[FlaUI](https://github.com/FlaUI/FlaUI) 的 UIA2/UIA3 抽象与 Pattern、
  [pywinauto](https://github.com/pywinauto/pywinauto) 的惰性窗口规格与等待、
  [Microsoft winapp CLI](https://github.com/microsoft/winappCli/blob/main/docs/ui-automation.md)
  的 AutomationId 优先、严格歧义和交互桌面安全边界。

## 本轮已经落地

- Core Locator 默认 strict，并提供显式 index policy；嵌套策略会复制冻结，macOS AX 后端
  已同步，多个候选不再静默取第一个。
- Core 已提供按需 test/worker fixture、串行化 setup、依赖解析、失败回滚、逆序 teardown
  和共享 close promise；worker 会拒绝先于尚未关闭的 test scope 退出。
- fixture metadata catalog 与可执行 `FixtureRegistry` 已接通，runner 能在启动前发现组件引用
  了尚未实现的 product fixture。
- Core 的 `session.actions` 已把 actionability 变成强制执行路径；后端必须声明支持的检查，
  缺失任何必需检查都会在副作用前失败。`force` 也不能跳过 attached/unique，普通参数只能
  增加、不能削弱默认检查，原生动作失败后不自动重放。Trace 会递归脱敏 token、API key、
  prompt、Bearer、diagnostic message 与敏感附件路径，并限制递归深度。
- 组件 manifest 已能声明 `requiredFixtures`，目录可按 fixture 反查受影响组件；Agent 的
  streaming、tool、approval、Computer Control、Emergency Stop、recovery 等组件已关联
  确定性 fixture/probe。
- Windows Host 提供只读 `host.doctor`，明确检查交互式桌面/UIA，并把 UAC Secure Desktop
  与输入注入标为能力边界；macOS Doctor 同样只读检查 App、AX trust 和 runner identity，
  两者都不会触发或自动接受系统授权。
- 跨语言 Doctor report 进入 Core 时严格解析；未知/重复/空状态、缺失预期 check 或非只读
  report 都会拒绝，而不是 fail-open。
- 独立 Reporter 已能从统一结果生成 `report.json`、AI Markdown 与 HTML，并按失败保留策略
  归档截图、录屏、trace 等相对路径附件；每个附件记录 MIME、大小、SHA-256、敏感标记和
  `captured/captureFailed/unsupported/notRequested` 状态。

这些是执行契约和可验证实现，不代表平台截图/录屏 provider、Trace viewer、完整 assertion
retry、Fake Driver 或第三方 Driver/Plugin 注册体系已经完成。

## 决定吸收的八个模式

### 1. 语义组件与产品定位器分离

借鉴 Page Object/Page Component，但组件边界采用用户可感知行为，例如 `Window`、
`FilePicker`、`Approval` 和 `Composer`。组件保持无产品状态；产品名称、文案、
`AXIdentifier`、`AutomationId` 由产品适配器提供。不会为每个 Button 创建一个组件。

### 2. 延迟解析的 Locator

Locator 表示查找条件，不长期缓存 AX/UIA 原生句柄。每次动作或断言前重新解析，默认要求
唯一匹配。定位优先级为稳定自动化 ID、限定父作用域的 role/control type + accessible
name、标签或文本；结构路径只作诊断 fallback，坐标默认禁用。

### 3. Fixture 依赖图与明确作用域

采用按需、可组合、setup/teardown 同处定义的 fixture 模型。基础作用域为：

```text
driverHost       run/worker scope
appSession       test scope
isolatedProfile  test scope
mockToolServer   worker scope
trace            automatic test scope
systemPermission exclusive scope
```

测试重试应获得新的 app session/profile，避免上一次失败留下的状态污染下一次执行。

### 4. Actionability 与可重试断言分开

动作执行前根据动作类型检查唯一、可见、enabled、editable、focusable 等条件；后端支持时
再检查 hit-test 或 receives-input。断言在统一 deadline 内重新定位和轮询，但批准、发送、
删除等副作用动作只允许 at-most-once，不能把整个动作自动重放。

### 5. Manifest、注册表与 Capability 预检

借鉴 Appium extension metadata 和 Robot 动态 keyword 元数据。组件 manifest 应继续演进为
可生成 TypeScript 类型、文档和 Agent tool schema 的唯一目录，并明确记录：

```text
id / apiVersion / kind
requiredCapabilities / optionalCapabilities
actions / assertions / sideEffect
platforms
每个 backend 的 specified / implemented / verified 状态
```

Session 创建前完成能力预检。缺少 required capability 时失败；缺少 optional capability 时
显式降级并写入 Trace，不能静默改用另一种输入方式。

### 6. Platform Driver 与横切 Plugin 分层

macOS AX、Windows UIA、未来的 WebDriver/WebView 实现属于 Driver；Trace、视觉快照、敏感
信息脱敏、Agent fixture、Computer Use 探索属于可选 Plugin。Plugin 必须显式启用，不能
改变 Core 的基础语义。高权限或可产生外部副作用的 Plugin 还需要单独的安全门禁。

### 7. 统一 Trace 与事件流

每个语义动作记录关联 ID、组件和动作名、源码位置、实际 Locator、采用的定位策略、耗时、
能力快照与错误。目标失败产物包含截图、AX/UIA tree、窗口/进程状态和 backend 日志；
当前已落地标准事件、脱敏、Doctor 和附件报告归档；真实截图、录屏与 UI tree 的平台采集仍在
后续计划中。
轻量事件可以始终记录；体积大的前后快照采用 retain-on-failure 或 retry 策略，并对密码、
对话内容、文件路径和附件做脱敏。

### 8. Doctor 与三层 Conformance 套件

参考 Appium Doctor 和 fake driver，建立三层一致性验证：

- Driver Contract：session 所有权、launch/attach/terminate、重新定位、等待、窗口、截图、
  cleanup 与错误分类。
- Component Contract：manifest schema、能力声明、动作前后置条件、副作用等级、无产品硬编码。
- App Adapter Contract：必需 Locator 唯一、本地化映射完整、敏感动作有门禁、版本升级后的
  locator drift 检查。

内存 Fake Driver 用于不具备 GUI 环境时验证组件逻辑；AX/UIA live smoke 用于验证真实平台。
`desktop-test doctor` 则在执行前检查权限、应用路径、交互式桌面、后端版本和 Secure Desktop
等环境条件。

## 明确不采用

- 不把 Core 迁移成 Appium、WebDriver、WebdriverIO 或 Robot Framework 的薄封装；这些可以
  成为兼容 backend/adapter，而不是唯一运行时。
- 不把 Robot Framework 文本 DSL 作为主要场景语言；可后续通过 manifest 生成可选 keyword
  adapter。
- 不采用全局 monkey patch 式 custom command。扩展必须有类型、命名空间、manifest 和版本。
- 不默认开启 implicit wait、固定 `sleep`、`force click` 或无限重试；等待统一由 deadline
  和可观察状态驱动。
- 不缓存跨动作的原生元素句柄，也不在唯一定位失败时自动选择第一个候选。
- 不把坐标、OCR、图像匹配或 Computer Use 设为确定性回归的隐式 fallback。它们只能作为
  显式能力或探索/诊断插件。
- 不自动重试具有外部副作用的动作，也不自动接受 TCC、UAC 或其他安全授权。

## 许可证与代码复用边界

本轮只阅读公开文档并吸收通用架构思想，没有复制第三方源码、测试、类型定义或文档段落，
也没有新增这些项目的运行时依赖。许可证参考：Playwright、Appium 和 Robot Framework 为
[Apache-2.0](https://github.com/microsoft/playwright/blob/main/LICENSE)，其中 Appium 与 Robot
Framework 的许可证分别见其 [LICENSE](https://github.com/appium/appium/blob/master/LICENSE)
和 [LICENSE.txt](https://github.com/robotframework/robotframework/blob/master/LICENSE.txt)；
WebdriverIO 使用其仓库中的 [MIT-style LICENSE](https://github.com/webdriverio/webdriverio/blob/main/LICENSE)。
原生桌面参考中，AXSwift、apple-fusion 与 FlaUI 为 MIT，pywinauto 为 BSD-3-Clause，
Appium Mac2 为 Apache-2.0。本轮同样只吸收接口与行为设计，没有引入这些仓库的源码或依赖。

如果未来引入包依赖、复制或修改实现代码，必须针对具体版本重新核对许可证、NOTICE、版权
标头、再分发要求和依赖树，并在仓库中记录来源；本文不是法律意见。

## 分阶段路线

1. **目录可信度**：继续为 manifest 增加 API 版本、optional capability 和逐平台
   `specified/implemented/verified` 状态，并实现 schema 检查。
2. **稳定执行语义**：在已落地 fixture、唯一性和 actionability 契约上，继续补实时重新定位、
   统一 deadline 和只读断言重试。
3. **可诊断性**：在已落地标准事件、脱敏和 Doctor 上，继续补 Trace archive、截图与 UI tree。
4. **生态扩展**：完成 Fake Driver、macOS/Windows Driver Contract，再开放有版本约束的
   Driver/Plugin 注册；最后按需要添加 WebdriverIO、Appium 或 Robot adapter。

任何阶段都应优先完成当前 macOS/Windows backend 的 contract，而不是先扩大组件数量。
