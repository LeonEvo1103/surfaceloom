# SurfaceLoom 入门指南

本指南从源码运行 SurfaceLoom 当前最完整的公开示例：一个确定性的 reference Agent、真实
Chrome/Chromium、Playwright v3 surface、Agent approval testing、独立 tool side-effect probe，
以及 Reporter v3 聚合报告。

## 前提条件

- Node.js 20 或更高版本，以及与之配套的 npm。
- Bash，用于运行仓库根目录的验证脚本。
- 可用的 Chrome 或 Chromium。浏览器在非默认位置时，设置
  `SURFACELOOM_BROWSER_EXECUTABLE` 为可执行文件的绝对路径。
- 足够的磁盘空间安装每个 package 自己 lockfile 中固定的依赖。

所有九个 TypeScript package 当前都是 `private`，且未发布到 npm。本指南使用仓库源码和本地
`file:` 依赖；不要替换成不存在的公共 registry 安装命令。

## 克隆并构建

```bash
git clone https://github.com/LeonEvo1103/surfaceloom.git
cd surfaceloom

./scripts/run-typescript-tests.sh
npm --prefix examples/reference-agent ci --ignore-scripts
```

`run-typescript-tests.sh` 会先运行公开内容审计，再按依赖顺序为九个 TypeScript package 安装依赖
（尚无 `node_modules` 时）并运行各包测试，最后运行仓库与产品合同发现。它不会下载 Playwright
浏览器；reference-agent showcase 使用已安装的 Chrome/Chromium。

如果只需要准备 browser backend 自己的显式 Chromium，可运行：

```bash
npm --prefix packages/browser-playwright ci
npx --prefix packages/browser-playwright playwright-core install chromium
```

也可以在调用 backend 时选择本机 Chrome channel。完整配置与安全边界见
[Playwright 浏览器后端](PLAYWRIGHT.md)。

## 运行四 Case showcase

```bash
npm --prefix examples/reference-agent run showcase
```

命令为每个 Case 启动新的 owned headless browser session，串行运行固定矩阵，并生成一个 Reporter v3
bundle：

| Case | 预期 AUT verdict | 验证重点 |
| --- | --- | --- |
| Deny, no execution | passed | 拒绝后工具调用和本地 effect 都为零，且观察区间完整 |
| Approve, exactly one execution | passed | 指定 call 恰好执行一次，独立资源 probe 也只看到一次 effect |
| Deny, but the tool executes | failed | UI 声称拒绝，但 ledger 与资源都证明发生了执行 |
| Deny with an incomplete ledger | failed | 缺少完成 barrier，不能把未知误判为零次执行 |

因此正常的聚合结果是 `2 passed / 2 failed`，进程退出码为 `1`。这两个红色结果是被保留下来的
产品故障，不是“预期失败所以转绿”的 meta-test。

退出码含义：

- `1`：showcase 成功完成并发布报告；固定的两个产品故障保持为 failed。
- `2`：基础设施、浏览器、验证、cleanup 或报告发布失败；不会发布最终 `complete.json`。
- `0`：不是当前固定 showcase 的正常结果；固定矩阵要求两个业务失败。

缺少可用浏览器时命令会失败，不会 skip。若设置自定义浏览器路径，只把它放在本地环境中，不要写入
仓库或报告。

## 检查报告

showcase 会打印本次唯一输出目录；默认位于
`examples/reference-agent/.artifacts/` 下。该目录包含：

```text
report/
  complete.json
  report.json
  ai-review.md
  index.html
  evidence/
```

`report.json` 是事实源；HTML 与 AI-review Markdown 从它确定性生成。`complete.json` 只在四个 Case、
附件复制与校验、子报告清理、聚合报告发布全部完成后出现。截图、trace 和其他附件可能包含敏感信息，
分享前按[安全策略](../SECURITY.md)检查。

Reporter 可以归档和渲染媒体，但 runner 或 backend 必须实际捕获它们；缺少权限应报告为
`unsupported`，不能自动触发系统授权。完整 schema、保留策略和验证边界见
[测试报告与 AI 验收](REPORTING.md)。

## 运行更完整的仓库验证

完整的 framework/reference-Agent 接受路径：

```bash
./scripts/run-framework-p1-tests.sh
```

该脚本包含九个 TypeScript package、仓库合同、仓库外 packed consumer、reference-agent unit/live
E2E 和 neutral login fixture contracts。packed consumer 安装候选 `.tgz` 的完整内部闭包；这是发布
候选证据，不代表 package 已发布到 npm。

只运行仓库外 packed consumer：

```bash
node scripts/service-packed-consumer/run.mjs
```

生成确定性的 Reporter 示例：

```bash
npm --prefix packages/reporter run example -- artifacts/reporter-example
```

在当前平台运行仓库检查并生成报告：

```bash
npm --prefix packages/reporter run repository-report
```

macOS 上该报告运行九个 TypeScript package、架构守卫和 Swift contracts；Windows 上运行九个
TypeScript package 与 .NET host contracts。它记录的是命令级检查，不能冒充每个内部 UI Case 都通过。

## macOS

前提条件：macOS 14+、Xcode 16+（含 Swift Testing）和 Swift tools 5.10。

```bash
./scripts/run-swift-tests.sh
```

该命令运行 side-effect-free contracts。`MacOSAutomationDoctor` 只以 `prompt: false` 读取
Accessibility 授权状态，不显示或接受 TCC prompt。测试覆盖真实 stdio subprocess handshake、协议、
lifecycle 和 fake-platform backend；不启动中性 GUI fixture，不证明 live AX，也不连接 TypeScript client。

需要了解中性 `.app` fixture 与当前限制时，阅读
[macOS fixture guide](../native/macos-fixture/README.md)。

## Windows

前提条件：Windows 10 version 2004+、.NET 8 SDK；live UIA 还要求前台、解锁且可交互的桌面 session。

```powershell
cd native\windows-host
dotnet build .\SurfaceLoom.WindowsHost.sln -c Release
dotnet run --project .\tests\SurfaceLoom.WindowsHost.ContractTests -c Release
cd ..\windows-fixture
.\scripts\live-conformance.ps1
```

live suite 只启动和清理自己拥有的 fixture process，不操作 UAC Secure Desktop，也不修改安全设置。
已登记的证据是 59 个 host contracts 和 5 个 C# client-to-UIA/lifecycle live Cases、零 skip；这不证明
TypeScript client-to-UIA path。协议和平台限制见
[Windows host guide](../native/windows-host/README.md)。

在仓库根目录用 PowerShell 验证九个 TypeScript package 和仓库 contracts：

```powershell
node .\scripts\audit-publication.mjs
$packages = @(
  "core", "component-catalog", "reporter", "agent-loop", "llm-judge",
  "test", "browser-playwright", "native", "service"
)
foreach ($package in $packages) {
  npm --prefix ".\packages\$package" ci
  npm --prefix ".\packages\$package" test
}
node .\scripts\run-repository-contract-tests.mjs
```

这与 Bash runner 一样按依赖顺序执行 package，但不会替代上面的 .NET host contracts 和交互式
live UIA fixture。

## 下一步

- 想理解结果为何可信：读 [能力事实矩阵](framework/capabilities.md) 和
  [Case 编写规范](CASE_SPEC.md)。
- 想扩展浏览器行为：读 [Playwright 浏览器后端](PLAYWRIGHT.md)。
- 想接入原生 desktop：读 [native package](../packages/native/README.md) 与相应平台 guide。
- 想贡献代码或文档：从 [贡献指南](../CONTRIBUTING.md) 和
  [文档导航](README.md) 开始。
