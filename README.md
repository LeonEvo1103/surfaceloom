# SurfaceLoom

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

面向 Agent 应用的跨 surface 语义化自动化测试框架实验。它把模型/工具 loop 与 macOS、
Windows 和浏览器 UI 的行为放进同一套测试与证据模型。目标应用可以使用
AppKit、SwiftUI、WPF、WinUI、Win32、Electron、Tauri 或其他技术，只要能暴露可靠的
Accessibility/UI Automation 语义树。

SurfaceLoom 把“要验证什么”与“系统如何操作 UI”分开：产品场景只调用可复用组件，
macOS Accessibility 和 Windows UI Automation 后端负责定位、动作、窗口与进程生命周期。
组件清单同时是机器可读数据，开发 Agent 可以先查询已有能力，再为功能改动补配套测试。

> 当前状态：可运行的工程实验，尚未发布稳定 API。适合验证架构、接入产品适配器和
> 执行受控 smoke；不应把它理解成完整替代 XCUITest、Appium 或人工验收的成熟产品。

框架化执行路线、原子任务状态和完成证据以 [Framework SSOT](docs/FRAMEWORK_SSOT.md) 为准；
[能力事实矩阵](docs/framework/capabilities.md) 区分接口声明、contract test、live fixture 和真实
目标应用证据。SSOT 中处于 `planned`、`ready` 或 `in_progress` 的能力均不是当前已交付能力。

本仓库只包含产品无关的框架、平台后端和模板，不内置任何具体产品适配器。框架不会修改
被测产品源码，也不会把测试生成物写回产品仓库。

## 它解决什么问题

- 用一套组件语义覆盖普通桌面应用和 Agent 类客户端。
- 让产品文案、test id、AX role、UIA control type 集中在产品 adapter，而不是散落在场景中。
- 默认严格定位，匹配多个元素时失败，不用隐式 `firstMatch` 掩盖问题。
- 区分测试拥有的进程与用户正在运行的进程，避免测试结束时误杀客户端。
- 通过副作用等级、fixture、doctor 和 trace 把真实模型、外部消息、权限流程等风险显式化。
- 给开发 Agent 提供可查询的组件与 fixture manifest，减少重复造测试抽象。
- 把 Agent、模型、工具、审批、桌面和浏览器事件归一为可脱敏、可合并、可视化的 loop trace。

## 当前能力

| 层 | 已实现 |
|---|---|
| Core | 跨平台 Driver/Session/Locator 契约、CaseSpec、actionability、fixture runtime、doctor、trace 脱敏 |
| Reporter | v2 单平台兼容报告；v3 host/surface/attempt/executionPlatforms、保守 v2 importer、中文 AI Markdown/浅色 HTML 与证据 hash |
| Native Protocol | `surfaceloom.native/1.0` schema、NDJSON framing、deadline/cancel、ownership、operation outcome 与 golden vectors；尚无统一 TS client |
| Component Catalog | 37 个桌面/System Surface/Agent 组件 manifest，7 个 fixture manifest；目录声明不等于行为实现 |
| Browser | 可选 Playwright Core backend、语义 DOM locator、严格单目标动作、截图与 trace；浏览器按需安装 |
| Agent Loop | 可扩展 TraceAdapter、统一 trace schema、Codex/原生/第三方 trace 导入、跨时钟合并与静态 HTML 时间线 |
| Execution Kernel | 可嵌入 Case 注册/执行、fixture/resource 生命周期、step/criterion、observation 自动等待、capability/effect preflight、deadline 与合作取消；最小顺序 CLI、过滤与 Reporter v2 bundle |
| macOS | Swift、Accessibility API、AppKit、窗口/菜单/文本/集合/文件面板、owned launch 与 non-owning attach |
| Windows | .NET 8、UI Automation/Win32、NDJSON host、进程 ownership、窗口与常用 UIA Pattern；真实 Windows conformance 待补 |

当前尚没有统一的 TypeScript native client、macOS stdio host、跨平台 native live conformance，
也没有并行、sharding、watch 等完整 runner。具体实现与证据边界见[能力事实矩阵](docs/framework/capabilities.md)。

组件 manifest `desktop.agent.computer-control` 与 `desktop.agent.emergency-stop` 表示“测试
Agent 客户端自身显示的 Computer Use 状态和停止入口”。它们不等于让测试框架依靠
Computer Use 操作电脑；确定性回归仍以 AX/UIA backend 为主，Computer Use 更适合探索
未知界面和辅助诊断。

## 仓库结构

```text
packages/
├── core/                         # TypeScript 跨平台契约与执行原语
├── browser-playwright/           # 可选 Playwright DOM backend，不污染 Core
├── agent-loop/                   # 通用 Agent loop schema、adapter 与静态可视化
├── component-catalog/            # 机器可读组件和 fixture manifest
├── reporter/                     # 机器/AI/人工三种测试报告视图
├── native/                       # 共享 native wire contract 与 golden vectors
└── test/                         # 可嵌入 Case execution kernel 与作者 API
Sources/SurfaceLoomMacOS/      # Swift + Accessibility/AppKit backend
Tests/SurfaceLoomMacOSTests/   # macOS backend contract tests
native/windows-host/              # C# + UI Automation/Win32 NDJSON host
projects/                         # 可选产品 adapter 的接入约定，不内置具体产品
Templates/                        # 新组件和场景模板
docs/                             # 架构、组件、Windows 和接入说明
```

依赖方向固定为：

```text
产品场景 → 产品适配器 → 通用/Agent 组件 → Core 契约 → 平台 backend
```

场景层不应出现 `AXUIElement`、UIA `ControlType`、虚拟键码或屏幕坐标。平台不具备所需
能力时必须返回明确的 `unsupported`，不能静默改用不稳定的坐标点击。

## 快速开始

### 通用契约与组件目录

要求 Node.js 20 或更高版本。脚本首次运行时会通过各 package 的 lockfile 安装依赖。

```bash
git clone https://github.com/LeonEvo1103/surfaceloom.git
cd surfaceloom
./scripts/run-typescript-tests.sh
./scripts/check-architecture.sh
```

`run-typescript-tests.sh` 会运行 Core、Playwright browser backend、Agent loop、组件目录、Reporter、仓库边界和自动发现的产品局部契约。
每个产品在自己的 `contracts` 中按 CaseSpec 的正式 `platforms` 校验原生测试名双向映射，并可通过
`projects/<product>/repository-checks.mjs` 自注册仓库报告检查；共享脚本不硬编码产品。生成一份不操作桌面的
确定性报告示例：

首个 Agent 审批 showcase 还会启动本机 Chrome/Chromium，执行真实 DOM 动作，并验证独立工具账本：

```bash
./scripts/run-framework-p1-tests.sh
```

该命令不会在缺少浏览器时静默 skip；可用 `SURFACELOOM_BROWSER_EXECUTABLE` 显式指定 Chromium
可执行文件。

```bash
npm --prefix packages/reporter run example -- artifacts/reporter-example
```

要实际执行当前平台可用的仓库验收，并把每条命令的真实退出状态、耗时和脱敏日志写入报告：

```bash
npm --prefix packages/reporter run repository-report
```

macOS 会运行七个 TypeScript package、架构守卫和根 Swift contracts；Windows 会运行七个
TypeScript package 与 .NET host contracts。这里汇总的是命令级检查，不是逐用例 importer。
HTML 默认使用浅色界面。输出目录会打印在命令末尾，且 Reporter 仍拒绝覆盖已存在的报告目录。

报告目录包含 `complete.json`、`report.json`、`ai-review.md`、`index.html` 和相对路径的
`evidence/`。默认截图、
视频只在失败或超时时保留；trace 始终保留。Reporter 已支持归档和展示媒体，但真实截图/录屏仍
由各平台 runner/backend 显式提供，权限不足时必须记录 `unsupported`，不能主动弹出授权。
详细设计见[测试报告与 AI 验收](docs/REPORTING.md)。
每条用例必须先定义中文 Case 名、原始语义、前置条件和验收条件，详见
[Case 编写规范](docs/CASE_SPEC.md)。

### Playwright 浏览器后端

网页 DOM 自动化使用独立的 `packages/browser-playwright`，不会让 Core 或原生桌面 backend
强制依赖 Playwright。安装 package 后，显式安装所需浏览器；只使用本机 Chrome 时可以在
`launch` 中设置 `channel: "chrome"`。

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
  context: { baseURL: "https://example.test", locale: "zh-CN" },
});

try {
  await browser.navigate("/login");
  await browser.fill(
    defineDomLocator({ key: "login.email", kind: "label", text: "邮箱" }),
    "fixture@example.test",
  );
  await browser.click({
    key: "login.submit",
    kind: "role",
    role: "button",
    name: "登录",
  });
} finally {
  await browser.close();
}
```

浏览器窗口、菜单、系统权限和文件面板仍由 AX/UIA backend 管理；页面 DOM、导航和网页断言
交给 Playwright。当前 backend 只启动并清理自己拥有的浏览器，不附加用户已运行的实例。
完整 API、定位器、安全边界和 Reporter 接线见 [Playwright 浏览器后端](docs/PLAYWRIGHT.md)。

### Agent loop 可视化

`packages/agent-loop` 把 Agent runtime、模型、工具、审批、原生桌面和浏览器 trace 归一到
`surfaceloom.agent-loop/v1`。Codex rollout JSONL 和 SurfaceLoom 原生 trace 是内置参考
adapter；第三方格式通过公开 adapter SDK 接入，无需修改 viewer。

```bash
npm --prefix packages/agent-loop ci
npm --prefix packages/agent-loop run build
node packages/agent-loop/dist/cli.js \
  --input /path/to/trace.jsonl \
  --output /tmp/agent-loop.html \
  --format auto
```

生成的 HTML 没有 JavaScript 或外部资源。原始 prompt、消息、reasoning、工具参数/输出、凭据和
用户路径在导入时省略或脱敏。多来源 trace 可按绝对时钟合并；时钟不完整时会明确降级并产生
warning。设计、安全边界与自定义 adapter 见 [Agent loop 轨迹与可视化](docs/AGENT_LOOPS.md)。

### macOS

要求 macOS 14 或更高版本，以及包含 Swift Testing 的 Xcode 16+ 或对应 Command Line Tools；
package manifest 的 tools version 为 Swift 5.10。

```bash
./scripts/run-swift-tests.sh
```

这条命令只运行无副作用的 contract tests。`MacOSAutomationDoctor` 以 `prompt: false` 读取
辅助功能授权状态，不会主动弹出或接受 TCC 窗口。

### Windows

要求 Windows 10 2004（build 19041）或更高版本、.NET 8 SDK 和可交互用户 session。

```powershell
cd native\windows-host
dotnet build .\SurfaceLoom.WindowsHost.sln -c Release
dotnet run --project .\tests\SurfaceLoom.WindowsHost.ContractTests -c Release
```

Windows host 不自动化 UAC Secure Desktop，也不会修改系统安全设置。详细协议和限制见
[Windows Host README](native/windows-host/README.md)。

若 Windows 环境没有 Bash，可以分别运行仓库内 package 命令：

```powershell
npm --prefix .\packages\core ci
npm --prefix .\packages\core test
npm --prefix .\packages\component-catalog ci
npm --prefix .\packages\component-catalog test
npm --prefix .\packages\reporter ci
npm --prefix .\packages\reporter test
npm --prefix .\packages\browser-playwright ci
npm --prefix .\packages\browser-playwright test
npm --prefix .\packages\agent-loop ci
npm --prefix .\packages\agent-loop test
npm --prefix .\packages\native ci
npm --prefix .\packages\native test
```

## macOS 产品接入示例

产品 adapter 负责 bundle、profile、定位器和组件，场景只表达行为：

```swift
struct SettingsComponent: MacOSComponent {
	let driver: MacOSApplicationDriver

	private static let button = MacOSAXLocator(
		"Settings button",
		identifiers: ["settings.open"],
		labels: ["Settings", "设置"],
		roles: [MacOSAXRole.button]
	)

	func open() throws { try driver.press(Self.button) }
}

try MacOSTestHarness.withApplication(configuration: configuration) { app in
	try app.component(SettingsComponent.self).open()
}
```

定位优先级是稳定 identifier，再回退到 adapter 维护的本地化 label；locator 默认要求唯一。
新增产品与场景的完整步骤见[添加测试指南](docs/ADDING_TESTS.md)。

## 安全模型

### 进程 ownership

- `owned`：由测试启动，允许在 teardown 中关闭或终止。
- `attached` / `external`：用户或外部系统启动，只能释放自动化引用，不能被框架终止。
- `system`：桌面、文件面板等系统 surface，不代表获得安全桌面权限。

普通 runner 默认拒绝接管已运行的同产品实例。attach 必须由产品 runner 显式开放，并要求
唯一目标，避免误操作其他窗口。

### 副作用等级

| 等级 | 示例 | 默认执行策略 |
|---|---|---|
| `readOnly` | 查看窗口和状态 | contract/CI 可运行 |
| `reversible` | 打开后取消文件面板 | 隔离 profile |
| `writesLocal` | 修改 fixture 文件 | 临时 workspace |
| `externalEffect` | 发消息、调用真实服务 | fake 优先，真实 smoke 显式启用 |
| `securitySensitive` | TCC、UAC、Computer Use 控制 | 专用用户或可恢复 VM |

框架不会自动接受 macOS TCC、Windows 隐私授权或 UAC；也不会调用 `tccutil reset`。完整首次
授权流程应放到专用测试用户或可恢复虚拟机中。

GUI runner 与被测进程可能继承当前进程环境。不要在 live/CI runner 中携带生产 token、
云平台密钥或真实模型凭据；只注入最小权限的测试变量。详见[安全说明](SECURITY.md)。

## 开发 Agent 如何使用组件库

组件目录可以按 kind、platform、capability 和最大副作用等级查询：

```ts
import { listComponentManifests } from "@surfaceloom/component-catalog";

const safeAgentComponents = listComponentManifests({
  kind: "agent",
  platform: "windows",
  maximumSideEffectLevel: "reversible",
});
```

这是仓库内 API；七个 TypeScript package 当前标记为 `private`，尚不能从 npm registry 安装。
不执行 TypeScript 的工具也可以在 build 后读取 `dist/catalog.json` 与 `dist/fixtures.json`。

推荐修改顺序：

1. 查询现有 component manifest 与所需 fixture。
2. 文案或 test id 变化只改 `projects/<product>` 的 schema/locator。
3. 产品行为变化优先新增或修改产品 scenario。
4. 只有出现跨产品复用语义时才扩展通用组件和 manifest。
5. 新平台原语只进入 backend，并补 driver contract test。

## 文档导航

- [架构与依赖边界](docs/ARCHITECTURE_V2.md)
- [组件目录与优先级](docs/COMPONENT_CATALOG_V2.md)
- [组件实现现状](docs/COMPONENT_LIBRARY.md)
- [开发 Agent 添加测试](docs/ADDING_TESTS.md)
- [Case 编写规范](docs/CASE_SPEC.md)
- [Windows 设计与选型](docs/WINDOWS.md)
- [Playwright 浏览器后端](docs/PLAYWRIGHT.md)
- [Agent loop 轨迹与可视化](docs/AGENT_LOOPS.md)
- [开源框架借鉴与取舍](docs/OPEN_SOURCE_INSPIRATION.md)
- [贡献指南](CONTRIBUTING.md)
- [安全说明](SECURITY.md)

## 已知边界

- API 与 manifest schema 仍可能变化，当前 package 标记为 `private`，尚未发布到 npm。
- macOS backend 以 AX/AppKit 为主；发布候选中的完整 TCC、系统弹窗和 XCUITest 流程仍需
  产品专属 target。
- Windows backend 尚未实现键鼠注入、通知中心和系统文件选择器专用组件。
- 真实 LLM、真实工具和跨进程 side-effect probe 只应作为少量显式 smoke，不属于默认回归。
- live GUI 测试需要前台、未锁屏的用户 session，应串行运行。

## 许可证

许可证信息见仓库根目录的 `LICENSE` 文件。

## 验证基线

提交前至少运行：

```bash
./scripts/check-architecture.sh
./scripts/run-typescript-tests.sh
./scripts/run-swift-tests.sh   # macOS
```

Windows 改动还需运行 Windows Host 的 build 与 contract tests。不要仅凭 UI 截图判断通过；
组件应断言语义状态，并对工具调用、外部写入等副作用使用 probe。
