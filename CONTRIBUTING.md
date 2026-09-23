# Contributing

SurfaceLoom 是仍在演进中的实验性工程。提交前请先确认改动所在层级，避免产品差异污染
共享框架。

首次参与请先按[文档导航](docs/README.md)完成“了解项目”和“跑通示例”，再根据改动类型进入
对应设计文档。本文件只定义贡献门禁，不重复能力状态与路线。

## 选择修改位置

| 变化 | 修改位置 |
|---|---|
| 产品文案、test id、AX role、UIA control type | `projects/<product>` adapter/schema |
| 产品 profile、启动条件、菜单或退出策略 | `projects/<product>` adapter |
| 产品验收行为 | `projects/<product>` scenarios |
| 跨产品可复用桌面或 Agent 行为 | 组件实现与 component manifest |
| 报告 schema、证据保留或 HTML/AI 展示 | `packages/reporter` |
| 通用 Agent loop schema、viewer 或 adapter SDK | `packages/agent-loop` |
| 某个产品/runtime 的 trace 格式 | 独立外部 adapter package，不进入本仓库内置 adapter |
| AX/UIA/窗口/进程的新原语 | 对应平台 backend 与 driver contract |

依赖只能是“产品场景 → 产品适配器 → 组件 → Core → backend”。场景不得直接出现
Accessibility/UIA 常量、键码或屏幕坐标。

## 实现原则

- 优先使用稳定 identifier：macOS `AXIdentifier`、Windows `AutomationId`。
- locator 默认严格唯一；不要用隐式首项匹配解决歧义。
- 所有 side effect 必须声明等级，并选择匹配的 fixture 与显式运行门禁。
- attached/external 进程只能 release/detach，不能被测试关闭或终止。
- 不自动接受 TCC、Windows 隐私设置或 UAC，不绕过 Secure Desktop。
- 真实 LLM 和工具只用于少量显式 smoke；日常回归使用确定性 fixture。
- PowerShell 源文件保持 ASCII；Unicode 正则用 `\uXXXX`，测试数据用 `[char]0xXXXX`
  构造，避免 Windows PowerShell 5.1 按系统 ANSI code page 误读无 BOM 的 UTF-8 源码。
- 单个源文件尽量控制在 250 行以内，大型 manifest 按领域拆分。

详细方法见[添加测试指南](docs/ADDING_TESTS.md)和[架构说明](docs/ARCHITECTURE_V2.md)。

## 共享组件变更门禁

现有组件是稳定接口，默认优先组合复用，不为单一产品或单一页面随意修改。产品文案、定位、
等待和兼容策略应留在 `projects/<product>`。只有现有组件的同一语义确实错误或不完整，并且
能够保持职责和兼容性时才修改它；独立且可跨产品复用的新语义应考虑新增组件。若当前只有一个
产品需要或复用边界尚不明确，先做产品局部实现。

新增或修改共享组件时必须：

- 检查目录中是否已有可组合或同义组件；
- 保持单一职责、既定依赖方向，以及普通桌面组件不依赖 Agent 组件；
- 不引入产品名、产品文案、产品路径或未声明的副作用；
- 不静默重命名 component id/action，也不破坏现有消费者；
- 同步更新 manifest、capability、locator key、side-effect、fixture、contract test 和文档；
- 在提交说明中解释现有组合为何不足、选择修改或新增的原因、影响范围与兼容策略。

## 本地验证

```bash
./scripts/check-architecture.sh
./scripts/run-typescript-tests.sh
./scripts/run-swift-tests.sh   # macOS
```

Windows backend 改动还需在 Windows 上运行：

```powershell
cd native\windows-host
dotnet build .\SurfaceLoom.WindowsHost.sln -c Release
dotnet run --project .\tests\SurfaceLoom.WindowsHost.ContractTests -c Release
```

live UI 测试必须串行运行，并在提交说明中列出目标 App 版本、运行模式、权限前提、实际副作用
和清理结果。不要提交用户 profile、录制中的敏感内容或本地绝对路径。

## 公开前审计

公开 PR 的 CI 只能发现已经上传的内容，不能作为首次泄漏防线。创建公开 PR 或 push 前，先在
隔离工作树运行：

```bash
node scripts/audit-publication.mjs
SURFACELOOM_FORBIDDEN_TERMS='local-only-term-1,local-only-term-2' \
  node scripts/audit-publication.mjs
```

第二条命令中的产品名、公司域名、内部 bundle id 等词表只保存在私有环境，不提交到本仓库。
历史审计使用 `--history`；默认扫描所有本地 refs，因此审计前先确认没有把私有 ref fetch 到
用于发布的 clone。验证一个准备发布的候选 ref 时使用 `--history --revision <ref>`。npm/ZIP/NuGet
等最终制品必须另外解包扫描，源码检查不能替代发布物检查。

## Pull Request 检查项

- 改动是否落在正确分层？
- 是否已经优先组合已有组件，而非为单一产品修改共享组件？
- 修改旧组件或新增组件是否有清晰、可复用的语义边界和兼容策略？
- locator 是否严格、可本地化且避免坐标？
- fixture 与 side-effect level 是否完整？
- attached/external 进程是否保持存活？
- 错误路径是否恢复菜单、窗口、临时目录和 owned 进程？
- 受影响的 contract、平台测试和架构守卫是否通过？
- skipped/unsupported 是否与 passed 分开，证据失败是否保留原始测试结论？
