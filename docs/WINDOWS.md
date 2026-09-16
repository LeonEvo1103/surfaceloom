# Windows 自动化后端设计

> 状态：设计决策与已实现骨架。`native/windows-host` 已提供 .NET 8 + UIA 的 NDJSON host；
> Windows live conformance 仍需在 Windows 交互式 VM 上执行。

## 1. 推荐结论

Windows 后端采用“UIA 为基础、一个当前实现、两个可选通道”：

1. **当前 executor**：.NET 8 直接封装 Windows UI Automation 与进程所有权，通过 NDJSON
   暴露 attach/find/invoke/setValue/selection/expand 等语义。
2. **诊断通道**：Microsoft winapp CLI 可快速提供 inspect、wait、screenshot 与文件对话框
   诊断，但不作为产品组件的硬依赖。
3. **长期封装选项**：当直接 UIA 维护成本上升时，可引入 FlaUI UIA3，同时保持协议不变。
4. **兼容 bridge**：Appium/WebDriver 只服务已有资产，不成为组件语义和 session ownership
   的唯一来源。

不建议用 WinAppDriver 作为新框架的核心。Appium Windows Driver 本身只是其代理，而且 Appium 项目已明确提示 WinAppDriver 多年未维护。FlaUI.WebDriver 有 W3C WebDriver 优势，但其项目明确标记为 experimental 和 feature incomplete，因此也不宜直接承担发布门禁。

## 2. 方案取舍

| 方案 | 定位 | 优点 | 约束与风险 | V2 决策 |
|---|---|---|---|---|
| Windows UI Automation | OS 原生可访问性与自动化 API | 覆盖常见桌面技术栈；支持 Invoke/Value/Toggle/Selection 等 Pattern | 它是底层 API，不提供完整 runner、fixture、诊断和产品组件 | 必选基础 |
| .NET direct UIA | 当前仓库实现 | 依赖少；直接控制协议、Pattern、进程所有权和错误模型 | 需要自行维护等待、缓存与诊断；必须在 Windows 验证 | 当前主后端 |
| Microsoft winapp CLI | 官方 UIA 命令行工具 | 支持 inspect/search/invoke/wait/screenshot/HWND；JSON 适合 Agent 与 CI；快速接入 | 需要 pin 版本与适配 CLI contract；子进程有开销；临时 slug 不可当长期 locator | 可选诊断后端 |
| FlaUI + UIA3 | .NET UIA 封装库 | 可直接持有元素与条件，适合复杂等待、Pattern fallback、进程所有权与高频调用 | 社区库；仍需维护自己的协议、runner 和错误模型；少数旧控件可能需 UIA2 fallback | 后续评估 |
| FlaUI.WebDriver | FlaUI 上的 W3C WebDriver server | TypeScript/Java/C# 都可复用 WebDriver 客户端 | 官方 README 标为 experimental、非完整实现；增加 server lifecycle | 只做实验 bridge |
| Appium Windows Driver | Appium 到 WinAppDriver 的代理 | 已有 Appium 团队迁移成本低；客户端生态成熟 | 仍依赖 WinAppDriver；额外 server 与 capability；底层维护风险不消失 | 兼容已有资产 |
| WinAppDriver | Selenium-like Windows 自动化服务 | 曾广泛用于 UWP/WinForms/WPF/Win32；样例多 | 最近正式 release 很旧；Appium 官方提示多年未维护；Developer Mode 与旧 host 假设 | 不新建依赖，只保留迁移期 |

参考：

- Microsoft winapp CLI UI Automation 文档：https://github.com/microsoft/winappCli/blob/main/docs/ui-automation.md
- FlaUI：https://github.com/FlaUI/FlaUI
- FlaUI.WebDriver：https://github.com/FlaUI/FlaUI.WebDriver
- Appium Windows Driver：https://github.com/appium/appium-windows-driver
- Microsoft WinAppDriver：https://github.com/microsoft/WinAppDriver

## 3. 为什么不把 Appium 当统一核心

统一协议有价值，但统一协议不等于统一语义：

- macOS Appium Mac2 基于 XCTest；Windows Appium Windows Driver 代理 WinAppDriver，二者成熟度与系统边界不同。
- 文件面板、托盘、权限、退出行为等系统表面仍需平台实现。
- WebDriver element 生命周期、窗口切换和错误模型不足以表达所有 AX/UIA Pattern 与安全门禁。
- 如果组件直接依赖 WebDriver selector，未来替换 Windows 后端会污染全部场景。

因此 V2 自己定义较小的 DesktopDriver 契约，并允许 Appium bridge 实现它。场景和组件不知道当前是 FlaUI、winapp CLI 还是 Appium。

## 4. Windows session 模型

每个 live case 拥有一个 DesktopSession：

    DesktopSession
      appProcessId
      ownedProcessTree
      mainWindowHwnd
      topLevelWindows
      fixtureId
      integrityLevel
      interactiveDesktop
      backendCapabilities

规则：

- 默认只启动并清理测试自己拥有的进程树。
- 发现同产品进程已运行时拒绝接管，除非场景和命令行都声明 attach。
- 同一 Windows interactive session 内的 live UI 测试串行。
- 优先用 HWND 锁定顶层窗口；窗口标题只用于发现，不作为长期身份。
- 多进程 Electron 应以顶层窗口和 owner process tree 关联，不假设所有控件都属于启动 PID。
- teardown 先请求产品语义退出，再在超时后记录诊断；是否 force terminate 由 fixture policy 决定。

## 5. UIA 定位器策略

优先级：

1. 唯一、开发者维护的 AutomationId。
2. 稳定容器内的 ControlType + AutomationId。
3. 稳定容器内的 ControlType + Name。
4. ClassName、FrameworkId 和受约束的祖先/后代关系。
5. 本地化 Name 列表。

不作为长期 locator：

- RuntimeId：控件重建后会变化。
- winapp 临时语义 slug：适合当前 inspect 会话，不是产品契约。
- 完整 XPath：树结构变化与性能风险高。
- 数组下标：排序、虚拟化、插入项后失效。
- 屏幕坐标：缩放、多显示器、窗口位置和 DPI 都会改变。

Windows 产品开发应给关键控件补 AutomationId。若一个组件只能靠 Name fallback，诊断报告必须标记 locator debt。

## 6. 动作映射

| DesktopDriver 动作 | UIA Pattern 优先路径 | 注入 fallback | 说明 |
|---|---|---|---|
| invoke | InvokePattern / SelectionItem / ExpandCollapse | mouse click | 先走控件语义 |
| setValue | ValuePattern / RangeValuePattern | focus + send keys | RichEdit 等可能只支持真实输入 |
| toggle | TogglePattern | click | 断言最终 ToggleState |
| select | SelectionItemPattern | click/key | 断言 IsSelected |
| scroll | ScrollItem / ScrollPattern | wheel | 虚拟列表需要重新 find |
| closeWindow | WindowPattern.Close 或产品策略 | Alt+F4 | 不自动等同于 quit |
| shortcut | 产品适配器映射 | SendInput | 系统快捷键需 allowlist |
| waitFor | UIA property/structure poll 或 event | 无 | 超时输出最后观察值 |

输入注入必须满足：

- 桌面未锁定，目标窗口处于正确前台。
- runner 与 AUT 的 integrity level 兼容；不要以提升权限作为默认修复。
- 键盘布局、IME、DPI 与显示器信息写入诊断。
- 系统级快捷键使用 allowlist；Win+L、Ctrl+Alt+Del 等不可恢复/安全序列禁止调用。

## 7. 进程、窗口与退出语义

Windows 没有 Cmd+Q 的统一等价物。产品适配器必须分别声明：

- closeWindow：关闭当前顶层窗口。
- quitApplication：通过 Exit 命令、产品 API 或关闭最后窗口请求完整退出。
- minimizeWindow：最小化当前窗口。
- sendToTray：如果产品明确支持，隐藏窗口并保留后台进程。
- reopenWindow：从托盘、任务栏、快捷方式或二次启动恢复窗口。

P0 case：

1. launch 后出现可交互顶层窗口。
2. Alt+F4/Close 的结果符合 app policy。
3. Exit 行为使 owned process tree 在 timeout 内退出。
4. tray app 的 close 与 quit 不被混淆。
5. 多窗口关闭一个窗口不误杀整个进程。
6. 崩溃、挂起或残留子进程会产生诊断并使测试失败。

## 8. 系统表面

### 8.1 Common Item Dialog

文件打开/保存对话框通过 UIA 和对话框 HWND 操作：

- 触发后枚举新的顶层窗口。
- 以 owner、class/control type 与出现时间识别，不只看本地化标题。
- 设置文件名或路径，验证选中项。
- 默认测试 Cancel；Select/Open/Save 属于 writesLocal 或 externalEffect，取决于目标。
- 路径必须位于 fixture 临时目录，禁止用户主目录和真实云盘目录。

### 8.2 Notification Area 与 Taskbar

- TrayStatusComponent 负责产品托盘图标、上下文菜单、恢复窗口和退出。
- TaskbarComponent 只验证产品窗口与任务栏状态，不修改用户 pinned apps。
- Windows 可能折叠托盘图标，组件要处理 overflow window，但不得用固定坐标。

### 8.3 Toast

- App 内 toast/banner 与 Windows 系统通知分成两个组件。
- 系统通知中心的历史、Focus Assist 和系统策略可能改变可见性；场景必须声明前置条件。
- 发送真实系统通知属于 writesLocal，使用测试 App identity 和清理策略。

### 8.4 UAC、隐私与 SmartScreen

- UAC secure desktop 不在普通 UIA/Input session 中，框架不得尝试绕过。
- 权限流程可验证“请求是否出现、用途文案/manifest 是否正确、拒绝后的产品状态”。
- 自动点击 Allow、修改 Windows Privacy Settings、关闭 Defender/SmartScreen 一律标记 securitySensitive 并阻止。
- 需要人工接受权限的 RC case 只输出 checkpoint 和证据，不伪造自动通过。

## 9. Windows fixture

| Fixture | 内容 | 允许行为 |
|---|---|---|
| win.empty | 临时 LocalAppData、空文档目录 | 生命周期与空状态 |
| win.seeded | 版本化列表、设置、对话数据 | 本地可逆修改 |
| win.fileDialog | 临时文件树与已知文件 | Open/Save/Cancel |
| win.tray | 独立测试 App identity | 托盘恢复与退出 |
| agent.tool-fixture | fake model/tool server | Agent 调用与审批 |
| agent.side-effect-probe | 调用次数账本 | 审批、停止与恢复后的零新增断言 |
| win.existing | 用户真实 profile | 只读；必须双门禁 |

fixture 不能依赖当前用户 Desktop、Documents、Downloads 的真实内容。测试账户、locale、缩放和 theme 要在 CI matrix 中显式声明。

## 10. CI 运行条件

UIA Pattern 类动作可减少真实输入依赖，但完整桌面 E2E 仍应使用专用 Windows VM：

- 固定 Windows build、语言、DPI 与主题。
- 使用有交互桌面的测试账户，保持 session unlocked。
- 避免 RDP 断开后导致桌面切换或锁定；runner 启动时自检。
- 不与人工操作共享 session。
- 同一 VM 串行跑 live suite；通过多 VM 扩并发。
- 每个失败保留 UIA tree、window list、截图、backend log 和进程树。
- 每次升级 winapp CLI、FlaUI、Windows build 或 App SDK 时先跑 conformance suite。

建议矩阵：

| Lane | Backend | 用途 | 门禁 |
|---|---|---|---|
| contract | 无 UI | manifest、包、权限声明 | 每次提交 |
| win-smoke | direct UIA host | P0 launch/window/dialog | 每次提交或每日 |
| win-regression | direct UIA；可选 FlaUI 增强 | 全部组件与产品场景 | 合并/夜间 |
| webdriver-compat | Appium bridge | 现有资产兼容性 | 可选 |
| win-rc | native/system surface | tray、权限可见性、installer | 发布候选 |

## 11. MVP 验收标准

Windows 被视为“进入框架”，至少满足：

- sample app 和至少一个真实产品适配器不共享产品定位器。
- launch/attach refusal/quit/process cleanup 通过。
- window/menu/dialog/text/list/file Cancel 通过。
- AutomationId 优先规则有架构检查。
- side effect gate 在动作前生效。
- 失败产物包含 UIA snapshot、窗口截图和 session 信息。
- 同一 component scenario 能在 macOS 与 Windows 运行，或明确返回 notApplicable 原因。
- WinAppDriver 未成为必装依赖。
