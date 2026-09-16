# SurfaceLoom 开发约束

这是独立的跨平台桌面自动化实验仓库。不得修改、复制生成物到或提交内容到任何被测产品
源码仓库；产品差异只能进入 `projects/<product>`。

## 分层规则

- `packages/core`：平台无关的 app/session/locator/capability 契约。
- `packages/component-catalog`：普通桌面、System Surface 与 Agent 扩展的机器可读 manifest。
- `packages/reporter`：跨平台测试结果、证据保留策略和 AI/HTML 报告，不实现 UI 操作。
- `packages/agent-loop`：产品无关的 trace adapter、统一 Agent loop schema、合并与静态 viewer。
- `Sources/SurfaceLoomMacOS`：Swift + AX/AppKit/CGEvent 的 macOS 实现。
- `native/windows-host`：C# + UI Automation/Win32 的 Windows 实现。
- `projects/<product>`：产品路径、locator、文案、profile、fixture 和验收场景。

依赖方向固定为：产品场景 → 产品适配器 → 组件 → Core → backend。共享层不得出现产品名；
场景不得直接出现 `AXUIElement`、`ControlType`、键码、坐标或平台驱动对象。

## 组件规则

- Button/TextField 等是底层 control，不要为每个控件制造一个空 Component。
- Component 表达一组可复用业务行为，例如 FileDialog、ApprovalGate 或 RunState。
- 稳定 `testId` 映射为 macOS `AXIdentifier` / Windows `AutomationId`，作为首选定位方式；
  role + 本地化名称只能作为集中在产品 schema 中的 fallback。
- 平台 escape hatch 只能出现在产品 schema 或 backend，不能进入场景。
- 普通客户端不依赖 Agent 组件；Agent 组件作为可选包依赖普通桌面组件。

## 共享组件变更门禁

- 默认把现有组件目录视为稳定接口。先组合已有 component、action 和 assertion，不得仅为让
  单个产品或单个页面通过测试而修改共享组件。
- 产品文案、test id、等待策略、兼容 fallback 和产品独有流程留在
  `projects/<product>` 的 adapter、schema 或 scenario，不得上移到共享组件。
- 只有现有组件的同一语义确实错误或不完整，且修改后仍保持原职责与兼容性时，才修改它；
  不得静默重命名 id/action、扩大副作用或破坏已有消费者。
- 出现独立、清晰且可跨产品复用的新语义边界时，可以新增组件，但应先检索目录，避免同义、
  重叠组件。只有单一产品需求或复用性尚未证实时，先实现为产品局部能力，待有复用证据再提升。
- 新增或修改共享组件必须保持单一职责和既定依赖方向，且不能包含产品名、产品文案或产品路径；
  同步补齐 manifest、platform、capability、locator key、side-effect、fixture、contract test 和文档。
- 提交说明应写明为何现有组合不足、为何选择修改旧组件或新增组件，以及受影响的消费者和兼容策略。

报告属于横切能力，不得创建 `ReportComponent`。runner/backend 负责截图、录屏和诊断采集，
Reporter 只归档结果与附件；`report.json` 是事实源，HTML 和 AI Markdown 必须由它确定性生成。
Agent loop adapter 必须在归一化边界省略或脱敏 prompt、消息正文、reasoning、工具参数/输出、
凭据和用户路径；viewer 不得依赖外部资源或执行 trace 内的脚本。

## 安全与副作用

- runner 必须拥有并清理自己启动的进程，默认拒绝接管已运行实例。
- `readOnly`、`reversible`、`writesLocal`、`externalEffect`、`securitySensitive` 必须通过
  manifest 声明；后两类需要显式运行门禁。
- 不调用 `tccutil reset`，不自动接受 TCC、Windows 隐私设置或 UAC。
- UAC Secure Desktop、完整 TCC 首次授权流放在专用用户或可恢复 VM 中。
- 不使用坐标点击作为静默 fallback；capability 不足时返回 `unsupported`。
- Agent E2E 默认接确定性模型/工具 fixture，并用 side-effect probe 验证调用次数；真实模型
  只运行少量显式标记的 smoke。
- live UI 套件串行运行，existing profile 默认关闭。

## 开发 Agent 的修改顺序

1. 查询组件 manifest 与产品 capability。
2. 文案、role、test id 变化只改 `projects/<product>` 的 schema。
3. 新产品行为先复用通用或 Agent 组件，再新增场景。
4. 只有出现跨产品可复用语义时才扩充组件和 manifest。
5. 新平台原语只放 backend，并补共享 driver contract。
6. 运行架构守卫、对应语言测试及受影响产品场景。

## Case 规范

- 新增或修改场景时必须同步定义 `CaseSpec`，不能只增加测试函数或命令。
- 本仓库内置 Case 使用 `locale: zh-CN`，必须有稳定 ID、中文 Suite/Case 名、原始语义、显式
  前置条件、带稳定 ID 的验收条件和副作用等级；Case 被加载时 Core 会强制检查中文字段。
- 可保留上游 XCTest/Swift Testing/TRX 原名为 `sourceName`，但它不能替代中文主名称或原始语义。
- 产品 sidecar 放在 `projects/<product>/cases/**/*.case-spec.json`；每个上游测试必须有且只有
  一个 `sourceName` 映射，并纳入仓库验证脚本。
- 运行状态、耗时、步骤、错误和证据只进入 `result`；步骤通过 `criterionIds` 关联验收项。
- `skipped`、`unsupported` 必须给出原因，命令级通过不得冒充其内部所有 UI Case 通过。
- 详细定义以 `docs/CASE_SPEC.md` 为准。

## 必须验证

macOS/Swift：

```bash
./scripts/run-swift-tests.sh
```

跨平台契约与组件目录：

```bash
./scripts/run-typescript-tests.sh
```

架构边界：

```bash
./scripts/check-architecture.sh
```

Windows 的命令以子目录 README 为准。单个源文件尽量保持
在 250 行以内；大型目录数据应拆成分类 manifest。
