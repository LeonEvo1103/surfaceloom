# SurfaceLoom Agent 测试框架 SSOT

> 状态：Active
>
> 当前代码基线：`9482192c29449597d0ec32af4e4713795779a8e8`
>
> 重新审计日期：2026-09-20
>
> 当前里程碑：A1——外部 Agent 通过 MCP 以精确代码版本调用一个已存在的任务，获得可追踪的真实
> 运行状态、结果和制品；不把 Planner、Runner 与 Judge 混成第二套执行内核。

本文档是 SurfaceLoom 产品边界、执行语义、实施顺序和完成证据的唯一事实源（SSOT）。
`docs/framework/capabilities.md` 只记录事实能力矩阵；README 只做对外说明。三者冲突时，先按源码和
可复现实验证据修正事实矩阵，再同步 README，不能用规划文字抬高能力等级。

## 1. 产品定义与成功标准

SurfaceLoom 是 **Agent 测试编排与验证框架**。它让 Agent 生成或维护的 UI/API 测试沉淀为可重复
Case，让外部 Agent 通过 MCP 在固定代码版本上执行这些 Case，并允许 Case 对明确范围的页面语义
调用 LLM Judge。Playwright、UIA、AX、winapp、XCTest 或其他工具是可替换执行后端，不是产品中心。

框架的中心仍是一次 `CaseExecution`：它把确定性 UI 行为、Agent run、tool lifecycle、实际资源
effect、显式语义判断、证据完整性和 cleanup 组合为一个保守 verdict。Planner 只负责选择、生成和
维护 Case；Runner 独占执行与确定性 verdict；Judge 只读取明确提供的证据，不能覆盖确定性失败。

已经做透的第一条用户故事是：

> Agent 请求向受控资源写入一条记录；审批 UI 允许或拒绝；Case 必须证明指定 run/call 的工具
> 生命周期、资源实际变化和清理结果，而不是只相信 UI 状态或 trace 文本。

下一阶段增加第二条公开用户故事：开发者给出登录流程的重要步骤和预期，Agent 可以维护 Case；稳定
步骤由 Playwright 执行，Case 只在显式节点调用 Judge 判断错误类型；此后同一任务可由 MCP 重复运行，
无需每次让 Agent 重新看图探索。

项目是否具有独立价值，由以下四个实验判定：

1. **故障识别：** UI 显示相同状态时，实际执行、截断账本、延迟 effect、未确认 cleanup 必须得到
   不同且正确的失败原因。
2. **后端替换：** 更换 browser/native backend 后，业务 Case 和预期 verdict 不变，变化限制在
   backend adapter 与 conformance。
3. **第二消费者：** 独立应用只新增 adapter/probe 就能复用 approval、duplicate、unknown 和 cleanup
   契约；若必须重写 ledger 和判定内核，则通用性假设失败。
4. **Agent 可调用：** 外部 Agent 与内置 Planner 必须调用同一 service；同一精确版本、参数和任务产生
   同一种运行记录，不允许出现“Agent 路径”专用 runner。

## 2. 当前事实基线

### 2.1 已交付且应保留

- observation 的 `unknown`、`read-failed`、截断或不完整状态不能满足负断言；零次与恰好一次需要
  稳定 `runId`/`callId` 和完成 barrier。
- execution kernel 会等待 action/step drain、逆序尝试全部 cleanup，并把正文失败、迟到失败、
  evidence 失败和 cleanup 失败共同纳入最终结果。
- native 协议区分 `notExecuted`、`executed`、`unknown`，并把 session release、target exit、host
  child exit 分开记录；timeout、kill 或 stdio close 不冒充资源已清理。
- Reporter v3、evidence materialization、显式 correlation、Browser/Native author facade、macOS stdio
  host 和 Windows C# UIA live fixture 已有独立合同或实验证据，具体等级以事实矩阵为准。
- reference-agent 故障矩阵已用真实 Playwright v3 固定覆盖 2 个绿色和 6 个红色 Case，包括跨 callId
  重复 effect、ledger 缺失/截断、stop 三态和 cleanup unconfirmed。

### 2.2 尚未交付

- Windows 5/5 live 经 C# client，不证明 TypeScript→host→UIA；macOS host contract 不证明 TCC 下的
  TypeScript→host→AX live。
- native effect 与 browser+native mixed-surface Case 尚未交付；Windows 真实 GUI gate 仍有账户 symlink
  权限阻断，不能把部分 live 证据扩大为完整统一 native 路径。
- 尚无通用 task service、MCP server、持久化 run lifecycle、LLM Judge 包、Planner adapter 或中性登录
  showcase；当前 CLI 的 v3 分支仍要求精确选择一个 Case，不是通用 suite runner。
- 没有仓库外 packed consumer，没有第二个公开消费者，也没有包含 service/Judge 的 npm alpha 发布证据。

### 2.3 第三方复用的真实状态

当前只有 Playwright 明确作为第三方 browser backend。winapp、Swift Wright、AXorcist、Appium Mac2
和 OpenTelemetry 都尚未集成；它们是候选基础设施，不能写成已交付架构。现有 Windows UIA、macOS
AX、native host/protocol 大量为自研代码。替换只能在同一 fixture conformance 和 verdict 不变后进行。

## 3. 冻结的产品边界

### 3.1 SurfaceLoom 拥有的语义

- Case/attempt、fixture、effect policy、deadline/cancellation、resource ownership 和 cleanup。
- Agent observation provider，以及 run/call/resource identity 与 completeness barrier。
- `notExecuted`、`executed`、`unknown` 和不可安全重试的动作提交语义。
- canonical result、证据来源/散列/correlation 与保守 Reporter verdict。

`ExecutionPolicyGate.dispatch()` 只保证框架本次调用回调一次，不证明 AUT 的业务操作只发生一次。
`assertAgentToolCallExactlyOnce()` 只证明指定 `callId` 的生命周期；还必须用独立资源 probe 检查同一
逻辑操作是否以其他 `callId` 重复产生 effect。

### 3.2 Backend 拥有的语义

- Playwright、UIA、AX、winapp、XCTest 等只负责查找、观察和执行平台动作，并如实声明 capability。
- backend 无法证明动作是否提交时必须返回 `unknown`，不得由 adapter 猜成成功或未执行。
- DOM、AX、UIA locator 和 action 保持强类型差异，不制造万能 `Element.click()`。
- 第三方 backend 可以直接实现公开 SPI；`surfaceloom.native/1.0` 是 first-party host 的可选协议，
  不是所有 backend 的强制传输层。

### 3.3 作者、adapter 与 runner

- Case 作者只写业务动作和业务断言；plan、policy、barrier、provider 和资源接线由可复用 adapter/config
  提供，不能要求每个 Case 重写底层仪式。
- 产品 adapter 负责 selector、run/call identity、ledger、effect probe 和语义行为；产品细节不得进入
  core/test/reporter。
- `sl-test` 与嵌入调用必须经过同一 kernel。首版只做发现、过滤、顺序执行、deadline、报告和 exit
  code，不自研通用 runner 生态。

### 3.4 Service、MCP 与 Planner

- `@surfaceloom/service` 拥有任务目录、工作区快照、执行器选择、运行状态、取消和制品读取；MCP 只是
  这组服务方法的一个传输入口，不能另写执行语义。
- Service 固定四类身份：`testId` 标识 catalog 中已登记的可执行测试，`operationId` 标识工作区准备，
  `runId` 标识一次执行，`taskId` 只标识 Planner 工作；四者不能混用。service `testId` 有自己的命名
  空间，不等同于 UI locator 的 `testId`；service `runId` 也不等同于 AUT/Agent/native 各自的 run 或
  operation identity。Run 必须显式关联 snapshot/revision、`testId`、归一化参数、可选 `taskId`，并按
  需关联 `CaseSpec.id`、Agent run/call 和 native operation identity。
- 第一个 command executor 只运行已登记的 argv，使用 `shell:false`、有界输出、deadline/cancel 和明确
  cleanup；MCP 参数不得直接拼成 shell。
- Planner 可以查找、创建或修改 Case，但只能在隔离工作区产出 patch；执行前冻结 revision，完成后返回
  diff 与 `runId`。它不能自行改变业务预期、提交、推送或合入。
- 公司 Git、部署、认证、机器调度、告警和产品任务发现属于消费方 adapter，不进入公开 service。
- 三仓依赖保持单向：公开 SurfaceLoom 提供通用 service/Judge/runner；私有组件库只提供产品 locator、
  action 和 evidence adapter；公司测试 Kit 只装配代码同步、runtime/auth/deploy、真实 Case 与巡检。
  私有仓可以消费公开包，公开仓不得读取私有路径、配置或产品实现。

### 3.5 LLM Judge

- `@surfaceloom/llm-judge` 接受显式 rubric、允许标签和有界证据，返回结构化 label、confidence、reasons、
  evidence references、模型与用量元数据。
- Judge 是可选断言/诊断，不是截图的默认全局评分器；未配置、超时、401/429/5xx、无效结构或证据不足
  必须得到明确的 `insufficient`/provider failure，不能判绿。
- evidence reference 必须存在且属于当前执行；Judge 必须把 observed facts 与 hypotheses 分开。只有页面
  证据时，后端根因只能是待验证假设或 `insufficient`，不能写成已证实原因。
- Fake provider 用于默认可重复测试；真实模型 smoke 必须显式启用。模型 API token 由消费方运行环境注入，
  不进入 Case、报告或仓库。

## 4. 明确冻结和非目标

当前阶段冻结：

- 新增 component/fixture manifest，以及没有真实消费者的组件行为扩张；现有 37 个组件主要是声明，
  不作为首页核心卖点。
- 通用 DOM/AX/UIA 动作扩张；仅当 M1/M2 参考闭环缺少必需能力且候选 backend 无法提供时补充。
- watch、sharding、worker pool、分布式调度和通用插件市场。
- 对任意截图自动打分的万能 Judge、让模型改写业务预期、无人工边界的 computer-use/browser-use runtime、
  自动 commit/push/merge 和远程 IDE；显式 LLM Judge 与受限 Planner 属于当前目标。
- 豪华 trace viewer 和通用日志平台；trace/OTel 只作为证据导入导出，不拥有 verdict。
- native wire 新特性；现有 ownership、receipt 和安全语义继续维护，除修复合同缺陷外不扩协议。

不立即删除现有 Windows UIA 或 macOS AX 实现，也不发动全面第三方替换。先证明候选 backend 能通过
同一中性 fixture、保留 operation/cleanup 语义并降低维护成本，再决定淘汰范围。

## 5. 黄金闭环与作者体验

M1 的 reference-agent 必须通过真实 Playwright surface port 和 v3 runner 执行，最终报告至少回答：

- 哪项 criterion 失败；
- UI 声称的 run/approval 状态；
- 指定 run/call/resource 的实际观察以及观察是否完整；
- 动作结果是否 unknown；
- cleanup 是否确认。

M1 最小矩阵：拒绝后 0 次和批准后 1 次为绿色；拒绝但执行、ledger 缺失/截断为红色。重复业务
effect、停止边界和 cleanup 未确认属于 M2 故障矩阵。预期失败的故障注入 Case 自身可以被测试套件
正确捕获，但其报告中的 AUT verdict 不得显示为 passed。

作者层目标形态如下，具体命名由实现任务在兼容现有 API 的前提下确定：

```ts
await expectAgent(run).toHaveRequestedApproval();
await expectAgent(run.tool("write-note")).toHaveExecutedExactlyOnce({ barrier });
```

这段示例是体验约束，不是已实现 API；不能先把它写入 README 冒充交付。

当前 reference-agent 的 effect 是内存中的 `local` resource。M1 必须用工具生命周期断言和独立 local
resource probe 验证它，不能调用只适用于 `boundary: "external"` 的零外部副作用断言来抬高证据等级。
真正 external resource 的否定断言留给提供可信完成 barrier 的后续消费者。

Agent 可调用闭环必须先支持“精确引用已存在任务”，再支持 Planner 写测试。首个 MCP 纵向切片为：

1. 消费方准备不可变工作区并返回 `operationId` 与 resolved revision；
2. Agent 查询 task catalog，并以结构化参数启动任务获得 `runId`；
3. service 按稳定 `testId` 通过登记 executor 执行现有 Node/CLI 或 SurfaceLoom v3 Case；
4. Agent 查询状态、结果和制品，断线重连后仍能读取；
5. 只有 Planner 任务使用 `taskId`，其 patch 必须在冻结 revision 后通过同一 service 执行。

中性登录 showcase 必须是 browser-only 的本地应用，包含两个入口、全新/旧账号、本地邮箱、测试模式
验证码和可开关的“旧账号误走注册”故障。默认 Fake Judge 可离线复现；可选真实 provider 只替换判断
层。示例不得接真实邮箱、真实验证码、公司页面或公司账号。

## 6. 里程碑门槛

| 里程碑 | 唯一主要闭环 | 完成门槛 | No-go |
| --- | --- | --- | --- |
| M1：可理解的 Agent Case | Browser approval 从高层作者 API 到 Reporter v3 | 真实 Playwright port；四项最小矩阵；一条仓库内命令生成 JSON/HTML/AI review；文档与事实矩阵同步 | 相对路径内部导入冒充外部 API；假报告；扩 manifest/native 驱动 |
| M2：执行边界与可替换 backend | 异步 stop + 一条 Browser→Native effect | 提交前取消、提交后 unknown、effect 已发生三态；Windows TS live；候选 backend 用同 fixture 比较；mixed Case 报告两面和 cleanup | cancel arrival 冒充 stopped；UI 状态冒充 effect；一次重写所有 backend |
| M3：独立消费与第二应用 | 源码树不可见的安装和复用 | packed consumer 用精确版本运行真实 Case/report；第二消费者只新增 adapter/probe；发布字节通过扫描和 provenance 门禁 | 借仓库 node_modules/tsc；产品规则进入 core；安装未闭合先发布 |
| A1：Agent 可调用执行 | MCP 精确版本运行已有任务 | task catalog、不可变 workspace、command executor、持久化 run、artifact/cancel；Node/CLI 真实任务可重复执行 | MCP 拼 shell；断线即丢结果；Planner 与 runner 共用一个不透明进程 |
| A2：语义判断闭环 | 登录 Case + Playwright + Judge + Reporter v3 | 正常/误分流/邮件缺失/Judge insufficient/provider failure；Fake 默认、真实模型显式；确定性失败不可被 Judge 覆盖 | 把 Judge 当万能 verdict；依赖真实邮箱/验证码；报告只有模型文本 |
| A3：Agent 维护 Case | 外部 Agent 或受限 Planner 产出 patch 后复跑 | patch→冻结 revision→同一 service 执行→返回 diff/runId；Codex Exec 与模型 API 共享工具合同 | Planner 改业务预期；自动提交合入；第二套执行器 |
| A4：公开安装 | 仓库外安装 browser/service/Judge 子集 | `.tgz` consumer 看不到源码树；无 `file:`；真实 browser task、MCP 与 Judge 报告通过 | 借 monorepo node_modules；先发 registry 再补 consumer；把旧七包合同静默改写 |

M1 与 M3、A1 与 A4 都严格分开：仓库内体验或 contract 不等于仓库外可安装。M1–M3 的历史任务和
证据继续有效；A1–A4 是面向 Agent 调用、Judge 与开源交付的新主线，不重写已完成事实。

## 7. 任务状态和完成证据

状态只允许：`planned → ready → in_progress → review → done`，或从 `in_progress` 转为 `blocked`。
实现 Agent 只能提交到 review；主 Agent 验收后才能置 done。

done 记录至少包含：taskId、sourceRevision、changedPaths、command、exitCode、platform、
executedTests、skippedTests、evidencePath、remainingLimitations。源码存在、manifest 声明、fake
contract 和 live conformance 必须分别记录；默认跳过的 smoke 不算完成证据。
本节验收记录的 `taskId` 专指 `SL-P*-*` 账本 ID，不是 service 中的 Planner `taskId`。

## 8. 原子任务账本

### P0：框架契约

| ID | 状态 | 依赖 | 排他写入范围 | 产物与 DoD |
| --- | --- | --- | --- | --- |
| `SL-P0-001` | done | — | `docs/FRAMEWORK_SSOT.md` | 本文档；任务 ID/依赖/第一波接口无冲突，`git diff --check` |
| `SL-P0-010` | done | `SL-P0-001` | `docs/framework/capabilities.md` | 逐项链接源码、测试、验证级别；明确 manifest/实现、bridge/contract/live 差距 |
| `SL-P0-020` | done | `SL-P0-001` | `scripts/check-framework-ssot.mjs`、对应 tests | 校验 ID、依赖、环、状态和 done 证据；不做调度系统 |
| `SL-P0-030` | done | `SL-P0-001`,`SL-P0-010` | README、AGENTS、`ARCHITECTURE_V2.md` | 增加 SSOT 入口并修正冲突，不把规划写成已实现 |
| `SL-P0-040` | done | `SL-P0-010` | `docs/framework/capabilities.md`、README 事实段 | 同步 Windows C# live、TS transport-neutral、macOS fixture build-only 与 P3/P4 边界；事实矩阵和 SSOT 不互相矛盾 |
| `SL-P0-050` | done | `SL-P0-040` | `docs/FRAMEWORK_SSOT.md` | 将路线收紧为 Agent 验证闭环优先，保留历史 done 证据；账本校验、架构检查和 GPT-6 反向审查通过后，由集成人关闭 |
| `SL-P0-060` | done | `SL-P0-050`,`SL-P3-094` | README、`docs/framework/capabilities.md`、相关入口文档 | 按 M1 实际证据同步对外事实；修正“无 macOS stdio host”等过时措辞，同时继续区分 host contract、TS binding 和 live AX/UIA |
| `SL-P0-070` | review | `SL-P0-060` | SSOT、AGENTS 与公开/私有仓边界说明 | 固化 open-source-first 的 service/Planner/Judge 分工、A1–A4 门槛和 P5/P6 原子任务；保留历史任务与证据；共识审查、独立反向审查、架构和 diff 门禁通过 |
| `SL-P0-071` | review | `SL-P0-020` | SSOT validator 与 tests | 校验器识别 P5/P6 及后续数字阶段，拒绝格式错误的任务 ID/依赖；继续检查重复、未知依赖、环、状态和 done 证据 |

### P1：首个可信 Agent Case

| ID | 状态 | 依赖 | 排他写入范围 | 产物与 DoD |
| --- | --- | --- | --- | --- |
| `SL-P1-010` | done | `SL-P0-001` | 新 `packages/test/**` | 可嵌入 executeCase、注册、step/criterion、正常 fixture 生命周期；成功、正文/setup/teardown 失败均生成合法结果且不覆盖首因 |
| `SL-P1-020` | done | `SL-P0-001` | 新 `examples/reference-agent/**` | 审批 HTTP fixture、确定性 run、独立工具账本、故障注入；拒绝 0、批准 1、重复批准不重复执行 |
| `SL-P1-030` | done | `SL-P1-010` | test package observation/assertion 子模块 | 自动重读、deadline、结构化 assertion/criterion；读取失败不等于 absent |
| `SL-P1-040` | done | `SL-P1-010` | test package plan/policy/effects 子模块 | capability 预检、effect descriptor/旧 enum 兼容；副作用前 fail closed |
| `SL-P1-051` | done | `SL-P1-030`,`SL-P1-040` | `packages/test/src/deadline*` 与对应 tests | 单调 deadline、合作取消信号和任务 settle receipt；等待结束不冒充任务停止 |
| `SL-P1-052` | done | `SL-P1-030`,`SL-P1-040` | `packages/test/src/resources*` 与对应 tests | 显式 ownership、逆序 cleanup、全部清理尝试与结构化 cleanup outcome；首因不被覆盖 |
| `SL-P1-053` | done | `SL-P1-030`,`SL-P1-040` | `packages/test/src/worker*` 与对应 tests | 隔离执行/停止状态契约；明确 cooperative stopped、worker terminated、unconfirmed 与 tainted |
| `SL-P1-050` | done | `SL-P1-051`,`SL-P1-052`,`SL-P1-053` | test package execution 集成、现有 kernel tests/exports | plan/policy 在 fixture 前；迟到 setup、挂起正文、cleanup 失败闭环；不能以 `Promise.race` 冒充停止 |
| `SL-P1-060` | done | `SL-P1-020`,`SL-P1-030`,`SL-P1-040`,`SL-P1-050` | reference-agent adapter/cases/e2e | 真浏览器拒绝 0、批准 1、拒绝后错误执行必失败 |
| `SL-P1-070` | done | `SL-P1-030`,`SL-P1-040`,`SL-P1-050` | test package CLI/report 子模块、bin/exports | CLI 与嵌入入口使用同一 kernel；逐 Case 报告和 exit code |
| `SL-P1-080` | done | `SL-P1-060`,`SL-P1-070` | 根 scripts/CI 与 SSOT 证据 | showcase + 普通非 Agent Case；全量 TS/架构/e2e，不能全 skip |

### P2：Windows native 垂直切片

| ID | 状态 | 依赖 | 排他写入范围 | 产物与 DoD |
| --- | --- | --- | --- | --- |
| `SL-P2-010` | done | `SL-P0-010`,`SL-P1-080` | 新 native package 协议 schema/vectors | 版本、ownership、deadline、错误、operation outcome、句柄范围 |
| `SL-P2-020` | done | `SL-P2-010` | `native/windows-host/**` | host 对齐协议且明确 0.2 兼容/停用策略，unknown 不重发 |
| `SL-P2-030` | done | `SL-P2-010` | native TS client/transport/tests | host 生命周期；错误版本、断线、超时、stale session、payload 边界 |
| `SL-P2-040` | done | `SL-P2-010` | 新 `native/windows-fixture/**` | 中性 UIA app：invoke/setValue/歧义/消失元素/owned lifecycle |
| `SL-P2-050` | done | `SL-P2-020`,`SL-P2-030`,`SL-P2-040` | Windows live tests/scripts/workflow | 真实 conformance，记录 OS/host/revision/Case 数，禁止全 skip |
| `SL-P2-060` | done | `SL-P2-010`,`SL-P2-030` | native schema/client/vectors 与跨语言 contract tests | 冻结重复 JSON key、UTF-8/EOF/frame limit、close failure、迟到 response/launch responsibility 与 cleanup receipt；TS/C# 严格对齐，Swift codec 在 `SL-P3-010` 接入同一 vectors 后补第三语言证据 |
| `SL-P2-070` | done | `SL-P2-060` | native Node process transport/tests | 真实子进程、`shell:false`、fatal UTF-8、LF/CRLF/完整 EOF 尾帧；bounded write admission/stderr retention；未 admission 请求不迟到发送；actual process exit 与 stdio close 分证据；跨平台 child 对抗测试；write/kill resolve 不冒充 operation/exit receipt |
| `SL-P2-080` | review | `SL-P1-052` | test package execution-wide Windows GUI gate、quarantine/recovery 与跨进程 tests | contention、取消等待、owner crash、陈旧锁/PID reuse、不能释放他人 lease；runner/native live 在 cleanup 与 publication 完成前持有同一 interactive-session gate，mixed GUI 复用该 gate |

### P3：macOS 与 multi-surface

| ID | 状态 | 依赖 | 排他写入范围 | 产物与 DoD |
| --- | --- | --- | --- | --- |
| `SL-P3-005` | done | `SL-P3-020` | macOS fixture app bundle/build/tests | 把裸 executable 封装为有稳定 bundle identity/Info.plist 的 `.app`；build 只算 artifact contract，不冒充 TCC/live AX |
| `SL-P3-010` | done | `SL-P2-060`,`SL-P3-005` | Package.swift、新 macOS codec/stdio host/tests | 同协议严格 frame/dispatcher；stdout 只承载 wire、错误脱敏、共享单调 deadline；不把 cancel arrival 冒充 AX 已停止 |
| `SL-P3-015` | done | `SL-P3-010` | macOS host lifecycle/handle/action adapter | opaque host/session handle、唯一 scope、单次提交、迟到 launch ownership、全部 cleanup 尝试；不隐式 fallback 坐标/键盘 |
| `SL-P3-020` | done | `SL-P2-010` | 新 macOS fixture | 与 Windows 同一行为契约的中性 app |
| `SL-P3-025` | done | `SL-P2-060`,`SL-P1-050` | native typed DesktopSession contract、Core per-call cancellation seam 与 kernel binding | 兼容现有 Core session；legacy void 不伪造 receipt；late acquisition 先登记 controller；borrowed target 与 owned reference 分离；unconfirmed cleanup 不释放 GUI 安全资格 |
| `SL-P3-030` | planned | `SL-P3-031`,`SL-P3-032` | native platform binding 聚合门槛 | 本轮不直接排期；交付拆为 Windows `SL-P3-031` 和 macOS `SL-P3-032`，完成两项后再关闭本聚合任务，避免重复实现 |
| `SL-P3-031` | done | `SL-P2-020`,`SL-P2-070`,`SL-P3-025`,`SL-P3-094` | Windows TS binding/codec 与 scoped tests | 接通既有 Windows host、typed DesktopSession 和 v3 native port；capability 与 handshake 对照；保留 ownership/receipt/unknown，只覆盖首条 native slice 所需动作 |
| `SL-P3-032` | planned | `SL-P3-015`,`SL-P3-025`,`SL-P3-031` | macOS TS binding/codec 与 scoped tests | 复用既有 macOS stdio host，不重做 host；M2 首条 Windows native 闭环完成或第二消费者明确需要 macOS 后再排期 |
| `SL-P3-040` | done | `SL-P1-080` | reporter package | report/v3 host/surface/attempt 和 v2 importer；不静默降级 |
| `SL-P3-050` | done | `SL-P3-040` | Core evidence context、agent-loop/tests | 显式 correlation；时间相邻不冒充因果，trace 不改 verdict |
| `SL-P3-055` | done | `SL-P3-025`,`SL-P3-040`,`SL-P3-050` | test runner report/v3 与 evidence materialization | runner 产生真实 host/surface/attempt/executionPlatforms；归档 trace/probe/graph，校验引用与脱敏，不改 authoritative verdict |
| `SL-P3-060` | planned | `SL-P2-050`,`SL-P2-080`,`SL-P3-031` | Windows TS live tests/scripts/CI | 真实 Node→binding→host→WPF/UIA 必需 Case 0 skip；原 C# 5/5 继续回归；lease 与 cleanup 实际参与，最终报告只能在 cleanup 后发布 |
| `SL-P3-065` | planned | `SL-P2-080`,`SL-P3-005`,`SL-P3-015`,`SL-P3-032` | macOS TS live tests/scripts/CI | Node→binding→host→AppKit/AX 同一必需 Case 集，0 skip；TCC 由实际 host identity 预检且不自动授权；不得用 Windows live 替代 |
| `SL-P3-070` | planned | `SL-P3-055`,`SL-P3-088`,`SL-P3-089` | mixed-surface example 与 integration tests | 先交付 Browser + Windows Native 的真实 Case；同一业务验收、native criterion、ledger/probe 和 cleanup 共同决定 verdict；报告含两种 surface。`SL-P3-065` 只证明 macOS TS native conformance；macOS mixed Agent parity 另行立项，不在本任务完成声明内 |
| `SL-P3-075` | done | `SL-P1-070` | test package project config、loader、CLI tests | `defineProject` 只组织已有 kernel；冻结配置优先级/路径/ESM-CJS 边界/重复 ID/退出码；TS Case loader 不借源码树工具 |
| `SL-P3-080` | done | `SL-P3-025`,`SL-P3-075` | browser/native surface fixture factories 与 author facade | 可选 backend 显式注入，不让 core/test 强依赖 Playwright/native；旧 `defineCase` 签名继续通过 |
| `SL-P3-085` | done | `SL-P1-030`,`SL-P1-060` | Agent observation provider/assertion wrappers 与 tests | 薄封装现有 observation assertion；run/call/resource/completeness 明确；“无外部 effect”只对有完成 barrier 的声明 external resource 成立 |
| `SL-P3-086` | planned | `SL-P3-087`,`SL-P3-088`,`SL-P3-089` | async/stop/native-effect 聚合门槛 | 本轮不直接排期；异步 executor、故障矩阵、native effect 分别由 `SL-P3-087/088/089` 交付，三项完成后再关闭本聚合任务 |
| `SL-P3-087` | done | `SL-P3-092` | reference-agent engine/ledger/server 与 unit tests | 同步 executor 扩为确定性可暂停、恢复、取消、settle；有显式提交点和完成 barrier；保留 runId/callId，纯异步语义不等待 native binding |
| `SL-P3-088` | done | `SL-P3-087`,`SL-P3-094` | 故障变体、CaseSpec、E2E/报告断言 | 固定覆盖拒绝却执行、跨 callId 重复业务 effect、账本缺失/截断、提交前停止、提交后 unknown、cleanup 未确认；同时核对业务 verdict 与证据，不只相信 fixture 自述 |
| `SL-P3-089` | planned | `SL-P3-087`,`SL-P3-060` | native effect executor/probe 与 scoped integration tests | 一个受控 native 操作产生可观察 effect；关联 run/call/逻辑操作与真实 operation receipt；probe 读取实际 effect，停止与断线后保守报告不确定性 |
| `SL-P3-090` | done | `SL-P3-075`,`SL-P3-080`,`SL-P3-085` | 作者/adapter 公开 export、reference 入口契约与 type tests | 补齐示例所需公开扩展点；消费者不 import `packages/*/src`、`dist` 或内部子路径；只复用现有 kernel/v3/Agent API，不建设第二套框架 |
| `SL-P3-091` | done | `SL-P3-090` | Playwright→v3 surface port 与 contracts/live tests | 真实 browser acquisition/action/deadline/cancel/close 进入现有 facade；strict locator 保持；提交边界不得过早，迟到 acquisition 或失败 close 不伪造 released |
| `SL-P3-092` | done | `SL-P3-090` | reference-agent adapter/provider/cases | adapter 实现现有 `AgentObservationProvider`；Case 使用高层断言；零执行与 local resource probe 共用完整 run barrier，不复制 policy/ledger/lifecycle 实现 |
| `SL-P3-093` | done | `SL-P3-055`,`SL-P3-075`,`SL-P3-090` | CLI/config 显式 v3 分支与 tests | 配置选择现有 `runCaseV3`，保留 v2 兼容入口；不创建第二 kernel；通过、业务失败、配置和发布失败的退出语义明确 |
| `SL-P3-094` | done | `SL-P3-091`,`SL-P3-092`,`SL-P3-093` | reference-agent E2E、入口脚本、真实报告验收与说明 | 一条命令运行 M1 四项矩阵并生成 v3 bundle；真实 browser 0 skip；报告关联 criterion、run/call、ledger/probe、完整性与 cleanup，不借私有代码入口 |
| `SL-P3-110` | planned | `SL-P3-060`,`SL-P3-094` | 第三方 backend adapter、同 fixture 对照与 conformance | 首选评估 winapp；相同 Windows fixture、Case 语义和预期 verdict 不变；记录 capability、锁、deadline、operation outcome 与 cleanup 差距后再决定是否替代 direct UIA |

### P4：可安装 alpha

| ID | 状态 | 依赖 | 排他写入范围 | 产物与 DoD |
| --- | --- | --- | --- | --- |
| `SL-P4-005` | done | `SL-P2-060` | release plan/manifest、包依赖图、兼容/签名/扫描设计与验证器 | 分离允许 pending 的 plan 与只记录最终真实 bytes 的 manifest；严格 schema、独立版本、无环 digest/SBOM/provenance/签名证据图和 fail-closed recursive scan；不发布 |
| `SL-P4-010` | planned | `SL-P3-070`,`SL-P3-110`,`SL-P4-005` | package manifests、locks、native 制品脚本、release CI | 无 `file:` 发布依赖；按当前 release contract 生成恰好七个候选包和对应 host 制品，固定版本且 license/exports/bin/assets 完整；未达 live 的平台必须显式标注；最终字节递归扫描并绑定 digest |
| `SL-P4-020` | planned | `SL-P4-010` | clean packed-consumer project/script | 隐藏源码树，在仓库外用消费端自己的依赖安装候选；真实 Browser+Native Case 与 report/v3，不用 fake backend/仓库 tsc |
| `SL-P4-030` | planned | `SL-P4-020` | 第二消费者 adapter example、conformance、release notes | 独立应用只通过公开扩展点增加 adapter/probe，复用 approval/duplicate/unknown/cleanup 契约；不得修改共享 core |
| `SL-P4-025` | planned | `SL-P4-020`,`SL-P4-030` | registry staging/publish/post-install workflow | 验证 npm scope/身份/provenance；发布后安装精确版本，以 `npx --no-install sl-test <case/config>` 运行，不下载 latest |
| `SL-P4-040` | planned | `SL-P0-070`,`SL-P4-005` | release graph/version contract | 版本化演进既有“恰好七包”v1 合同，增加 service/Judge/browser 子集 release profile；旧合同与证据原样保留，不能静默改快照 |
| `SL-P4-050` | planned | `SL-P4-040`,`SL-P5-070`,`SL-P6-050` | 新包 manifests、exports、license/third-party notices、候选 tgz | browser/service/Judge 所需闭包无 `file:`，MIT 与第三方许可证完整，bin/assets/optional provider 清单与最终字节一致 |
| `SL-P4-060` | planned | `SL-P4-050` | 仓库外 consumer 与验证脚本 | 独立临时目录只安装 `.tgz`，运行真实 Browser+service+Judge Case 并生成 Reporter v3；文档明确 Fake/real provider 差异 |
| `SL-P4-070` | planned | `SL-P4-060` | registry staging/publish/post-install workflow | registry 发布与候选构建分离；发布后按精确版本安装并重跑，不用 tag/latest 或源码目录兜底 |

### P5：Agent 可调用测试服务

| ID | 状态 | 依赖 | 排他写入范围 | 产物与 DoD |
| --- | --- | --- | --- | --- |
| `SL-P5-010` | planned | `SL-P0-070`,`SL-P0-071` | 新 `packages/service` contracts/catalog/tests | 定义带稳定 service `testId` 的 TestDefinition、WorkspaceProvider、Executor、RunResult、artifact 与 cancel 合同；TestDefinition 显式列 0..n 个 CaseSpec 引用、覆盖/排除、参数、runtime/effect；四类 ID 与执行状态/业务 outcome 分离 |
| `SL-P5-020` | planned | `SL-P5-010` | service workspace provider/tests | 本地不可变 snapshot provider 返回 resolved revision、runtime/AUT metadata；失败不回退当前工作树；准备操作以 `operationId` 追踪；active/unconfirmed run 的 snapshot 不复用 |
| `SL-P5-030` | planned | `SL-P5-010` | service command executor/tests | `shell:false` argv、cwd/env allowlist、有界 stdout/stderr、deadline/cancel、进程身份与 cleanup；未知/基础设施退出不得伪装产品失败，cleanup 永不确认时有界结束为 `unconfirmed/tainted` |
| `SL-P5-040` | planned | `SL-P5-020`,`SL-P5-030` | service run store/artifact store/tests | dispatch 前持久化 `runId` 及 snapshot/`testId`/参数/可选 `taskId`，按调用方 `requestId` 幂等；响应丢失重试返回原 run；断线可重读；重启后恢复 owned process 或隔离为 interrupted+tainted，未确认 cleanup 不释放 workspace；cancel 有界终态化 |
| `SL-P5-050` | planned | `SL-P5-040` | service MCP server/SDK adapter/tests | 使用正式 MCP SDK 暴露 prepare/status/catalog/run/get-result/get-artifact/cancel；结构化 schema、四类 ID、`requestId` 与 lifecycle 同 service，不拼 shell、不复制 runner；断开 MCP 不等于取消 |
| `SL-P5-060` | planned | `SL-P5-040`,`SL-P3-094` | service SurfaceLoom v3 executor/tests | 通过公开 API 调用现有 v3 kernel，保留原 verdict、Reporter v3、deadline 与 cleanup；command 成功不能冒充其中所有 Case 通过 |
| `SL-P5-070` | planned | `SL-P5-050`,`SL-P5-060` | 中性 provider/consumer conformance | 独立 consumer 执行 Node/CLI 与 v3 任务，验证 prepare→run→reconnect→artifact→cancel，并注入“已启动但响应丢失”、service crash+存活 child、cleanup 永不确认；不得重复执行或复用 tainted workspace；私有消费证据只作补充 |

### P6：语义判断与 Agent 维护工作流

| ID | 状态 | 依赖 | 排他写入范围 | 产物与 DoD |
| --- | --- | --- | --- | --- |
| `SL-P6-010` | planned | `SL-P0-070`,`SL-P0-071` | 新 `packages/llm-judge` contracts/fake/tests | 定义 rubric、允许标签、有界 multimodal evidence、当前 run evidence refs、observed facts/hypotheses、structured result、`insufficient` 与 provider failure；Fake provider 可重复，provider SDK 为可选依赖 |
| `SL-P6-020` | planned | `SL-P6-010` | llm-judge provider adapter/tests | 基于成熟 SDK 的结构化输出、AbortSignal、deadline、401/429/5xx、token/latency metadata；未知标签 fail closed；真实 API 只做显式 smoke |
| `SL-P6-030` | planned | `SL-P6-010`,`SL-P3-055` | test/reporter Judge integration/tests | Case 显式声明 Judge criterion，结果进入 Reporter v3 evidence/correlation；确定性失败、insufficient 或 provider failure 不能被模型改绿，不创建 Reporter v4 |
| `SL-P6-040` | planned | `SL-P0-070` | 新 `examples/login-testing` fixture/tests | 中性本地登录应用与邮箱：两个入口、全新/旧账号、测试模式验证码、可开关误分流故障、稳定 run/attempt identity；账号/邮箱/验证码按 attempt 隔离并可重置，连续两次与故障恢复后结果一致；不接真实模型/邮箱/公司页面 |
| `SL-P6-050` | planned | `SL-P5-050`,`SL-P5-060`,`SL-P6-020`,`SL-P6-030`,`SL-P6-040` | login Playwright Cases、MCP showcase、Reporter assertions | 真实 Playwright 覆盖正常/误分流/邮件缺失/Judge insufficient/API failure；Fake 默认、real opt-in；一条命令通过 MCP 生成可解释报告 |
| `SL-P6-060` | planned | `SL-P5-050`,`SL-P5-070` | `packages/service/src/planner/{contracts,tools}/**` 与 tests | Planner 只能 catalog/read/write patch/run/diff；外部 requirement/acceptance 为只读保护对象，CaseSpec 预期变化必须单独提出并经外部确认；patch 后冻结 revision并调用同一 service，返回 diff 与 `runId`；禁止 commit/push/merge |
| `SL-P6-070` | planned | `SL-P6-060` | `packages/service/src/planner/codex/**` 与 tests | 可配置 binary/version/model，限隔离工作区、预算、取消和工具白名单；fixture contract 必需，真实 Codex 只做显式 smoke |
| `SL-P6-080` | planned | `SL-P6-020`,`SL-P6-060` | `packages/service/src/planner/model-api/**` 与 tests | 使用同一 Planner tools 的结构化 tool loop，限制轮次/token/写入范围；无第二 runner，provider/预算错误结构化返回 |

## 9. 并行施工规则

M1 的 `SL-P3-090/091/092/093/094` 与 M2 的 `SL-P3-087/088` 已完成。native 路径继续按既有依赖推进，
但不阻塞 browser-first 的 A1/A2。第一波只并行 `SL-P5-010`、`SL-P6-010`、`SL-P6-040`；三者分别
写 service、Judge 与中性示例，不修改共享 exports、lock、SSOT、Reporter schema 或根 CI。主集成人
统一处理新 package manifests/exports、根接线和全量回归。

第二波按依赖推进 workspace/command executor、provider adapter 与 Judge integration；MCP 必须等 run
lifecycle 固定后接入，Planner 必须等 MCP/consumer conformance 后接入。不能为了展示 AI 而越过 A1，
也不能要求现有消费方先把所有传统 Node/CLI 测试迁移成 `defineCaseV3`。

即使源码目录互斥，`core/dist`、package exports、locks、Reporter schema 和根 CI 仍共享。实现 Agent
只运行 scoped typecheck/test；主集成人串行运行全量构建、架构守卫和 SSOT 校验。修改
`packages/*/src/index.ts`、package manifest/lock、Package.swift、Reporter schema 或根 CI 必须指定
单一集成人。

Windows host/fixture/protocol 变更必须回归 C# host contracts 和不可跳过的 5 项 WPF/UIA live；新增
TypeScript live 由 `SL-P3-060` 单独证明。macOS contract、fixture build、真实 handshake 均不能替代
TCC 下的 live AX。Linux 交叉编译、fake 或 portable model 不能替代任一平台 live 证据。

## 10. 扩展与版本边界

首个 alpha 对已有包只承诺 product adapter、fixture provider、Agent observation/resource probe、完成
后的 report 消费接口和已有 TraceAdapter。新 service 开放 TestDefinition、WorkspaceProvider、Executor、
run/artifact store 与 MCP transport 扩展点；新 Judge 开放 provider adapter 与结构化判定合同；Planner
只开放有界工具合同。任意生命周期 hook、全局 service container、scheduler interception 和万能 AI
evaluator 暂不开放。

npm 包、native wire protocol、report schema、trace schema 和 component behavior/manifest 分别版本化。
当前 ReleasePlan/ReleaseManifest v1 合同固定恰好七个 npm 包；`SL-P4-040` 必须通过新版本/profile 显式
演进，不能篡改旧快照或证据。consumer 可以只安装所需依赖闭包。平台支持必须标明 declared、
contract-tested、live-fixture-tested 或 target-app-tested；没有 live 证据只能写 contract-tested。

## 11. 验收记录

| taskId | sourceRevision | changedPaths | command / exitCode | platform | executed / skipped | evidencePath | remainingLimitations |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SL-P0-001` | `0230973e9539838f9393509b7b32681fde4c2c1b` | `docs/FRAMEWORK_SSOT.md` | `git diff --check` / 0 | macOS | 1 document contract / 0 | `docs/FRAMEWORK_SSOT.md` | 账本自动检查器由 `SL-P0-020` 交付；规划能力均未计为实现。 |
| `SL-P0-020` | `aebb24c43af1c664f39bce9ab0b705c517a1d0c2` | `scripts/check-framework-ssot.mjs`、`scripts/lib/framework-ssot.mjs`、`scripts/tests/framework-ssot.test.mjs` | `node --test scripts/tests/framework-ssot.test.mjs && node scripts/check-framework-ssot.mjs` / 0 | macOS | 2 tests / 0 | `scripts/tests/framework-ssot.test.mjs` | 只验证账本结构，不调度任务，也不替代人工能力证据审查。 |
| `SL-P0-010` | `aebb24c32f3dec0e7b51c369656cd2d27430dabb` | `docs/framework/capabilities.md` | `node` 本地链接检查与 `git diff --check` / 0 | macOS | 75 links（65 unique targets）/ 0 | `docs/framework/capabilities.md` | 无 target-app 证据；browser live smoke 未执行；macOS/Windows 仍缺统一 TS native bridge 和中性 fixture live conformance。 |
| `SL-P0-030` | `dc1e6c67ae6d88e069f74efe1dc3091e120c7a1c` | `README.md`、`AGENTS.md`、`docs/ARCHITECTURE_V2.md` | `node scripts/check-framework-ssot.mjs && ./scripts/check-architecture.sh && git diff --check` / 0 | macOS | 2 contract checks / 0 | `README.md`、`AGENTS.md`、`docs/ARCHITECTURE_V2.md` | 只统一权威入口与事实措辞；未把 execution 规划计为实现。 |
| `SL-P0-040` | `c9a235e2eaef8b379c0fd7748deea14e2cc73360` | `README.md`、`docs/framework/capabilities.md` | `node scripts/check-framework-ssot.mjs && ./scripts/check-architecture.sh && git diff --check` / 0 | macOS | 2 document/architecture checks / 0 | `README.md`、`docs/framework/capabilities.md` | 明确 Windows 5/5 live 经 C# client、macOS `.app` 只到 artifact contract、TS native 仍无 process transport/live；未提升任何未验能力。 |
| `SL-P0-050` | `91df92f206ffac6ac295f1b1874ac1f2aa527a15` | `docs/FRAMEWORK_SSOT.md` | `node scripts/check-framework-ssot.mjs && node --test scripts/tests/framework-ssot.test.mjs && ./scripts/check-architecture.sh && git diff --check` / 0 | macOS / Node 22 | 58-task ledger + 2 validator tests + architecture / 0 | `docs/FRAMEWORK_SSOT.md`、`scripts/tests/framework-ssot.test.mjs` | 只收紧产品边界、里程碑和原子依赖；未把 M1–M3 规划写成已交付能力。 |
| `SL-P0-060` | `3534a731cc12fc7a96d9a6d11d1beae0c9f013b6` | `README.md`、`docs/framework/capabilities.md` | 本地 Markdown 链接检查 + `./scripts/check-architecture.sh && node scripts/check-framework-ssot.mjs && git diff --check` / 0 | macOS / Node 22 | 152 local links + architecture + 58-task ledger / 0 | `README.md`、`docs/framework/capabilities.md` | M1、macOS stdio host 和 Windows C#→UIA live 事实已同步；仍无 TS→native live、macOS TCC/AX live、target-app 证据或通用 multi-Case v3 CLI，sharding/watch 保持冻结。 |
| `SL-P1-020` | `cbd21b9d43e681e924015cda20095583f31f478e` | `examples/reference-agent/**` | `npm ci --ignore-scripts && npm test && git diff --check` / 0 | macOS / Node 22 | 11 tests / 0 | `examples/reference-agent/test` | 内存 effect；无真实 browser/model/外部服务；ledger 不对任意伪造快照提供密码学认证。 |
| `SL-P1-010` | `80f3302c09ab8967cc85a86e0abdbb4e55afc67f` | `packages/test/**` | `npm ci && npm run typecheck && npm test && npm pack --dry-run` / 0 | macOS / Node 22 | 24 tests / 0 | `packages/test/tests` | 无 CLI、deadline/强制取消、policy/effects、自动 observation 或真实 backend conformance；挂起的非合作 JavaScript 仍会等待。 |
| `SL-P1-030` | `f72a0d21849dc256973faa92410fdf32b38d8214` | `packages/test/src/assertion*`、`observation*`、`errors.ts` 与对应 tests/exports | `npm run typecheck && npm test && npm pack --dry-run` / 0 | macOS / Node 22 | 32 scoped tests（77 package total）/ 0 | `packages/test/tests/assertion*.test.ts`、`observation.test.ts` | reader/provider 的真实重读与 completeness 是信任契约；无强制取消，挂起 reader 仍会等待。 |
| `SL-P1-040` | `f72a0d21849dc256973faa92410fdf32b38d8214` | `packages/test/src/plan*`、`policy*`、`effects.ts` 与对应 tests/exports | `npm run typecheck && npm test && npm pack --dry-run` / 0 | macOS / Node 22 | 25 scoped tests（77 package total）/ 0 | `packages/test/tests/effects.test.ts`、`plan-preflight.test.ts`、`policy-dispatch.test.ts` | 尚未接入 executeCase；依赖 backend 如实声明 capability/effect，不是任意 JavaScript sandbox。 |
| `SL-P1-051` | `28cae810d8f8b40b06b783a12387b4e7461b742a` | `packages/test/src/deadline*` 与对应 tests | `npm run typecheck && npm test` / 0 | macOS / Node 22 | 23 scoped tests（160 package total）/ 0 | `packages/test/tests/deadline*.test.ts` | 只能合作取消异步任务；不能抢占同步 JavaScript 或 detached 工作；Node 20 API 兼容但实测为 Node 22。 |
| `SL-P1-052` | `28cae810d8f8b40b06b783a12387b4e7461b742a` | `packages/test/src/resources*` 与对应 tests | `npm run typecheck && npm test` / 0 | macOS / Node 22 | 32 scoped tests（160 package total）/ 0 | `packages/test/tests/resources*.test.ts` | cleanup 超时只证明回执未确认；同步阻塞与恶意 Promise species 仍需隔离层兜底。 |
| `SL-P1-053` | `28cae810d8f8b40b06b783a12387b4e7461b742a` | `packages/test/src/worker*` 与对应 tests | `npm run typecheck && npm test` / 0 | macOS / Node 22 | 28 scoped tests（160 package total）/ 0 | `packages/test/tests/worker*.test.ts` | 现有 Case 闭包不自动迁入 Worker；Node 入口只管理调用方 owned Worker，不能证明 detached/external effects 已回滚。 |
| `SL-P1-050` | `5aaa8a1e3800b0b5d1d5353dee90f58d20575b87` | `packages/test/src/contracts.ts`、`execute.ts`、`execution-*`、resources contract/tests、exports 与 README | `npm run typecheck && npm test && npm pack --dry-run && git diff --check` / 0 | macOS / Node 22 | 12 scoped integration tests（173 package total）/ 0 | `packages/test/tests/execution-lifecycle.test.ts`、`execution-dispatch.test.ts` | in-process 同步阻塞与 detached JavaScript 不可强停；timeout 只结束等待并保守标记 unconfirmed/tainted；Node Worker 强制终止不证明外部副作用已回滚。 |
| `SL-P1-060` | `2f89ea71e981a67c9ac8e0afff529cd77fd89da5` | `examples/reference-agent/adapter/**`、`cases/**`、`tests/e2e/**` 与使用说明 | `npm test && npm run test:e2e` / 0 | macOS / Node 22 / Chrome | 11 fixture tests + 4 live browser E2E / 0 | `examples/reference-agent/tests/e2e/approval.e2e.test.mjs` | live 证据限受控 browser fixture；无真实模型、native surface 或外部 effect。 |
| `SL-P1-070` | `2f89ea71e981a67c9ac8e0afff529cd77fd89da5` | `packages/test/src/cli/**`、`src/report/**`、对应 tests、exports/bin/manifest | `npm run typecheck && npm test && npm pack --dry-run` / 0 | macOS / Node 22 | 13 scoped CLI/report tests（186 package total）/ 0 | `packages/test/tests/cli/**`、`packages/test/tests/report/**` | 顺序执行；无 worker pool、sharding、watch、插件加载或未编译 TypeScript Case loader。 |
| `SL-P1-080` | `2f89ea71e981a67c9ac8e0afff529cd77fd89da5` | `scripts/run-framework-p1-tests.sh`、CI、README 与共享接线 | `./scripts/run-framework-p1-tests.sh && ./scripts/check-architecture.sh && node scripts/check-license-contract.mjs` / 0 | macOS / Node 22 / Chrome | 6 package suites + 68 repository contracts + 11 fixture tests + 4 required live E2E / 3 optional browser smoke skips，required E2E 0 skip | `scripts/run-framework-p1-tests.sh`、`.github/workflows/ci.yml` | P1 只交付 browser 纵向切片；native parity、强隔离通用 Case、并行 runner 和 report/v3 留在后续阶段。 |
| `SL-P2-010` | `2ebc6ccae2ce97e373f09d8abb2c97e9c5755a1a` | `packages/native/**`、TS 根测试/CI 接线 | `npm run typecheck && npm test && npm pack --dry-run` / 0 | macOS / Node 22 | 26 protocol tests / 0；45 packed files | `packages/native/tests`、`packages/native/vectors/v1` | 只有共享 wire contract；尚无 TS transport、已迁移 host 或真实 native conformance。Windows 0.2 明确不是共享协议别名。 |
| `SL-P2-020` | `7d79157c9bc2e582d79950ab68b97542243868f4` | `native/windows-host/**` | `dotnet build SurfaceLoom.WindowsHost.sln -c Release && dotnet run --project tests/SurfaceLoom.WindowsHost.ContractTests -c Release` / 0 | Windows 11 / .NET 8 | 52 host contract cases / 0；Release build 0 warnings/errors | `native/windows-host/tests/SurfaceLoom.WindowsHost.ContractTests` | legacy 0.2 与 1.0 严格隔离；contract executable 验证协议和 dispatcher，但真实 UIA/lifecycle 由 `SL-P2-050` 单独证明。 |
| `SL-P2-030` | `8db8418` | `packages/native/src/client/**`、`tests/client/**`、export/README | `npm test && npm run typecheck && npm pack --dry-run && git diff --check` / 0 | macOS / Node 22 | 30 client tests（56 package total）/ 0；69 packed files | `packages/native/tests/client` | transport-neutral fake contract；未提供 host process transport，不宣称真实 native conformance。连接生命周期内 request/operation/tombstone 账本按协议不淘汰。 |
| `SL-P2-040` | `8d047c7` | `native/windows-fixture/**` | Node tests + Docker WPF Release build + portable .NET model run + `git diff --check` / 0 | macOS + Linux ARM64 container targeting Windows | 8 Node tests + 16 model checks，WPF build 0 warnings/errors / 0 | `native/windows-fixture/tests`、`fixture-contract.v1.json` | 证明源码、XAML 与 portable model；没有在 Windows 启动 GUI、查询 UIA pattern 或验证 process exit，live 责任仍属于 `SL-P2-050`。 |
| `SL-P2-050` | `7d79157c9bc2e582d79950ab68b97542243868f4` | `native/windows-host/**`、`native/windows-fixture/**` | `native/windows-fixture/scripts/live-conformance.ps1` / 0 | Windows 11 interactive session / .NET 8 | 5 live WPF/UIA/lifecycle cases / 0 | `native/windows-fixture/artifacts/windows-live-conformance.json`（runner-local） | 证明真实 UIA invoke/value/strict ambiguity/transient recovery/owned process exit；报告来自与该 revision 内容一致的远端工作树，未另行从 commit archive 重跑，生成制品不作为静态仓库文件提交。 |
| `SL-P2-060` | `714d790` | `packages/native/src/client/**`、framing/vectors/tests、`native/windows-host/**` | `npm --prefix packages/native run typecheck && npm --prefix packages/native test`；Windows `dotnet run --project tests/SurfaceLoom.WindowsHost.ContractTests -c Release`；`native/windows-fixture/scripts/live-conformance.ps1` / 0 | macOS / Node 22；Windows 11 / .NET 8 | 63 TS contract tests + 58 C# host contract cases + 5 live UIA regressions / 0 | `packages/native/tests`、`packages/native/vectors/v1`、`native/windows-host/tests/SurfaceLoom.WindowsHost.ContractTests`、Windows runner-local live JSON | TS/C# 已共享严格 duplicate-key/UTF-8/EOF/frame/close 契约；5/5 live 仍经 C# client/UIA，不证明 Node process transport；Swift codec 留给 `SL-P3-010`。 |
| `SL-P2-070` | `9a0171386834c5b906d3d6a424641e35697ed85c` | `packages/native/src/node-transport/**`、`packages/native/tests/node-transport/**`、child fixture、公共 export | `npm --prefix packages/native run typecheck && npm --prefix packages/native test` / 0；专项 8 路并发 40 轮 / 0 | macOS / Node 22 | 97 package tests（28 process-transport scoped）+ 80 并发边界执行 / 0 | `packages/native/tests/node-transport` | 真实 child/stdio contract 已证明；未在 Windows/Linux 重跑，不证明 native target 或后代进程清理，也不替代 TS→UIA/AX live。 |
| `SL-P3-020` | `b4d53d6` | `native/macos-fixture/**` | `./scripts/verify.sh && git diff --check` / 0 | macOS / Swift 6 / Node 22 | 8 Swift model tests + 10 Node parity/static tests + AppKit Release build / 0 | `native/macos-fixture/Tests`、`fixture-contract.v1.json` | 未启动 GUI、未请求 TCC、未执行 live AX；只证明模型、源码、Windows 行为 parity 与可构建性。 |
| `SL-P3-005` | `c9a235e2eaef8b379c0fd7748deea14e2cc73360` | `native/macos-fixture/AppBundle/**`、`scripts/build-app.sh`、artifact tests/docs | `./native/macos-fixture/scripts/verify.sh` / 0 | macOS / Swift 6 / Node 22 | 8 Swift model + 13 Node model/parity/artifact tests / 0 | `native/macos-fixture/Tests/app-bundle-contract.test.mjs` | 证明 `.app` bundle identity、Info.plist、Mach-O minimum OS、可重复及空格路径构建；没有启动 GUI、安装应用、请求 TCC 或执行 live AX。 |
| `SL-P3-040` | `2ebc6ccae2ce97e373f09d8abb2c97e9c5755a1a` | `packages/reporter/src/v3/**`、`tests/v3/**`、公开 export | `npm run typecheck && npm test && npm pack --dry-run` / 0 | macOS / Node 22 | 18 v3 tests（54 reporter total）/ 0；111 packed files | `packages/reporter/tests/v3` | CLI 仍输出 report/v2；v3 需要 runner 提供真实 host/surface/attempt/executionPlatforms，不自动伪造。 |
| `SL-P3-050` | `2dad348` | Core evidence context、agent-loop correlation、exports/peer/外部消费脚本 | Core/agent-loop test+typecheck+pack，external adapter，`git diff --check` / 0 | macOS / Node 22 | 10 Core evidence tests（53 total）+ 10 correlation tests（30 agent-loop total）/ 0；63/87 packed files | `packages/core/tests/evidence-context.test.ts`、`packages/agent-loop/tests/correlation` | 只接受显式 binding，不自动从时间/相邻事件/correlationId 猜因果；尚未物化为 report/v3 artifact，不能修改 authoritative verdict。 |
| `SL-P3-085` | `c9a235e2eaef8b379c0fd7748deea14e2cc73360` | `packages/test/src/agent-observation.ts`、公共 exports、对应 tests | `npm --prefix packages/test run typecheck && npm --prefix packages/test test` / 0 | macOS / Node 22 | 7 scoped Agent assertion tests（193 package total）/ 0 | `packages/test/tests/agent-observation.test.ts` | provider/ledger 的真实性仍是 adapter 信任边界；exactly-once 与 zero-effect 只在匹配的完成 barrier 后成立，不能从 unknown/truncated/read-failed 推断。 |
| `SL-P3-075` | `ee9d4b8` | `packages/test/src/project*`、`src/cli/**`、interactive-session implementation/tests、公共 exports | `npm --prefix packages/test run typecheck && npm --prefix packages/test test` / 0 | macOS / Node 22 | 234 package tests / 0 | `packages/test/tests/project*.test.ts`、`packages/test/tests/cli/**`、`packages/test/tests/interactive-session*.test.ts` | 配置文件本身使用 JavaScript；TypeScript Case 需要消费方提供 runtime；CommonJS 配置为显式异步 Promise；输出路径预检仍有静态检查固有 TOCTOU；仓库外 packed consumer 留给 P4。 |
| `SL-P3-025` | `9a0171386834c5b906d3d6a424641e35697ed85c` | Core per-call invocation、native DesktopSession、test native binding、公共 exports 与 tests | Core/native/test `typecheck` + full package tests；两个 strict type fixtures；`git diff --check` / 0 | macOS / Node 22 | Core 59 + native 97 + test 265 package tests / 0 | `packages/core/tests/per-invocation-cancellation.test.ts`、`packages/native/tests/desktop-session`、`packages/test/tests/native-binding` | typed contract、Windows v1 mapping、late acquisition 与 identity-bound cleanup 已证明；P3-030/060/065 的平台 binding 和 live UI 尚未实现。 |
| `SL-P3-031` | `9293f825bd88c6658596ec97f2c8ea7128441841` | `packages/native/src/windows/**`、Windows scripted-host/packed-consumer tests、test native binding/call-context seam、release graph contract | `npm --prefix packages/native test && npm --prefix packages/native run typecheck && npm --prefix packages/test test && npm --prefix packages/test run typecheck && ./scripts/run-framework-p1-tests.sh && ./scripts/check-architecture.sh && node scripts/check-framework-ssot.mjs && git diff --check` / 0 | macOS / Node 22 | native 138 + test 338 package tests；scripted Windows v1 host/v3 runner 21 scoped tests / 0 | `packages/native/tests/windows/**`、`packages/native/tests/fixtures/windows-v1-scripted-host.mjs`、`packages/test/tests/native-binding/native-binding.test.ts`、`packages/test/tests/p3-080-surfaces-lifecycle.test.ts` | 已证明 Node process→Windows v1 codec→typed DesktopSession→真实 `runCaseV3` 的 contract 闭环，以及 ownership、deadline、unknown/no-retry 与 cleanup receipt；当前 child 是脚本 host，未证明真实 Windows host/WPF/UIA，live 责任仍属于 `SL-P3-060`；`waitForWindow:false` 明确拒绝。 |
| `SL-P3-010` | `96098ced6131d632ffdb473a38caca533411e0d6` | `Sources/SurfaceLoomNativeProtocol/**`、`Sources/SurfaceLoomMacOSHost/**`、stdio executable、Swift tests、共享 vectors | `./scripts/run-swift-tests.sh --skip-architecture && swift build --product surfaceloom-macos-host && ./scripts/check-architecture.sh`；真实 handshake pipe / 0；Windows contract + live 回归 / 0 | macOS / Swift 6；Windows 11 / .NET 8 | Swift 78 tests / 0；Windows host 59 cases + WPF/UIA 5 live cases / 0 | `Tests/SurfaceLoomNativeProtocolTests`、`Tests/SurfaceLoomMacOSHostTests`、`packages/native/vectors/v1`、Windows runner-local live JSON | 证明严格 framing、真实 stdio host、跨语言 vectors 与 host handshake；Windows live 仍经 C#，macOS 未做 TCC/AX live，不能替代 `SL-P3-060/065`。 |
| `SL-P3-015` | `96098ced6131d632ffdb473a38caca533411e0d6` | `Sources/SurfaceLoomMacOSHost/**`、lifecycle/AX adapter 与对抗 tests | `./scripts/run-swift-tests.sh --skip-architecture && ./scripts/check-architecture.sh && git diff --check` / 0 | macOS / Swift 6 | 39 host-scoped regressions；78 Swift total / 0 | `Tests/SurfaceLoomMacOSHostTests/MacOSNativeBackend*Tests.swift`、`NativeHost*Tests.swift` | ownership、迟到 launch、cleanup single-flight、SIGPIPE/EPIPE、terminal-write cancel、AX per-handle deadline 已通过 contract；未做 TCC/真实目标 App live，非合作目标进程不能被协议凭空证明停止。 |
| `SL-P3-055` | `40ae0e654543e0fe6ab99e77ad19a73e86d1347a` | `packages/test/src/evidence/**`、`src/report/v3/**`、`runner-v3*`、Reporter required-artifact 写入与 tests | test/reporter `npm test` + `npm run typecheck`；`git diff --check` / 0 | macOS / Node 22 | test 321 + reporter 57 / 0 | `packages/test/tests/p3-055*`、`packages/reporter/tests/v3/p3-055-required-artifact.test.ts` | authoritative identity、required artifact digest/size、hostile getter/Proxy 零执行与 failure-no-complete 已证明；路径 claim 仅同一 JS 模块实例进程内，不是跨进程/worker/物理别名锁。 |
| `SL-P3-080` | `40ae0e654543e0fe6ab99e77ad19a73e86d1347a` | `packages/test/src/definition-v3.ts`、`runner-v3*`、`surfaces/**`、公共 facade 与 tests | `npm --prefix packages/test test && npm --prefix packages/test run typecheck` / 0 | macOS / Node 22 | 321 package tests / 0 | `packages/test/tests/p3-080*`、`p3-055-p3-080-runner-v3*.test.ts` | 显式 `defineCaseV3/runCaseV3` author facade 与 browser/native surface contract 已完成；v3 配置 CLI、真实 backend/live、P3-086/P3-070 尚未完成。 |
| `SL-P3-090` | `91df92f206ffac6ac295f1b1874ac1f2aa527a15` | `packages/test/src/agent-author.ts`、Agent assertion/runtime guards、公共 exports 与 public-entry tests | `npm --prefix packages/test test && npm --prefix packages/test run typecheck && ./scripts/run-typescript-tests.sh && ./scripts/check-architecture.sh && npm pack --dry-run --json` / 0 | macOS / Node 22 | 328 package tests + 14 scoped public/Agent tests / 0；379 packed files | `packages/test/tests/agent-author.test.ts`、`agent-observation.test.ts`、`p3-090-public-entry.test.ts`、public consumer type fixture | 高层 facade 只绑定现有 assertion；exactly-once 仍限精确 callId，业务 effect 需独立 probe；self-reference 证明包根出口，不等于 P4 仓库外安装。 |
| `SL-P3-091` | `20a2ac9c42660253f6de08cdf0f4c782bf3f251b` | `packages/browser-playwright/**`、TypeScript 根构建顺序与 release peer metadata contract | `npm --prefix packages/browser-playwright run test:local && ./scripts/run-framework-p1-tests.sh && git diff --check` / 0 | macOS / Node 22 / Chrome | 64 browser package tests（含 2 条 v3 live）+ 99 repository contracts / 0 | `packages/browser-playwright/tests/v3-*.test.ts`、`scripts/tests/release-contract/plan.test.mjs` | live lane 使用本机 system Chrome；v3 子入口需匹配版本的 `@surfaceloom/test`，legacy 根入口不需要；失败或挂起 cleanup 只报告 unconfirmed，不伪造 released。 |
| `SL-P3-092` | `20a2ac9c42660253f6de08cdf0f4c782bf3f251b` | `examples/reference-agent/**`、`scripts/run-framework-p1-tests.sh`、CI lock cache | `./scripts/run-framework-p1-tests.sh` / 0 | macOS / Node 22 / Chrome | 15 reference unit tests + 4 required live browser E2E / 0 | `examples/reference-agent/test`、`examples/reference-agent/tests/e2e` | 证明受控浏览器 fixture 的 approval、exact call、完整 barrier 与 local probe；无真实模型、native surface 或外部 effect。 |
| `SL-P3-093` | `20a2ac9c42660253f6de08cdf0f4c782bf3f251b` | `packages/test/src/project*`、`src/loader*`、`src/cli/**` 与 public type/CLI tests | `npm --prefix packages/test test && npm --prefix packages/test run typecheck && ./scripts/run-framework-p1-tests.sh` / 0 | macOS / Node 22 | 336 test package tests + hostile Promise/public v2 type regressions / 0 | `packages/test/tests/cli/v3-project.test.ts`、`packages/test/tests/fixtures/p3-093-v2-loader.type-fixture.ts` | 当前 v3 CLI 每次要求精确选择一个 Case；多 Case 编排、聚合 v3 bundle 与一键 M1 入口属于 `SL-P3-094`。跨 realm Promise、Promise subclass 与 Proxy 配置按 fail-closed 拒绝。 |
| `SL-P3-094` | `38eee9ade11205694ae3db1d9a5e0b70ca8feb05` | `examples/reference-agent/showcase/**`、showcase unit/live E2E、README 与 package scripts | `npm --prefix examples/reference-agent test && npm --prefix examples/reference-agent run test:showcase:live && npm --prefix examples/reference-agent run test:e2e && ./scripts/run-framework-p1-tests.sh` / 0 | macOS / Node 22 / Chrome | 25 unit/contract tests + 1 dedicated live showcase + 5 full E2E / 0 | `examples/reference-agent/test/showcase-*.test.mjs`、`examples/reference-agent/tests/e2e/showcase.e2e.test.mjs` | 固定 M1 四 Case 串行 showcase，聚合本次同进程可信 `runCaseV3` 结果；业务矩阵诚实保持 2 绿 2 红/exit 1，基础设施或清理失败 exit 2 且不发布 final complete。无真实模型、native surface 或外部 effect；不把同信任域 Case 作者视为恶意输入。 |
| `SL-P3-087` | `ff9e0fd089cb0702c6ed07376f46c645ee5463d9` | `examples/reference-agent/src/{checkpoints,executor,engine,server,page}.mjs`、browser adapter 状态兼容、README 与异步/页面竞态 tests | `npm --prefix examples/reference-agent test && npm --prefix examples/reference-agent run test:e2e && ./scripts/run-framework-p1-tests.sh && ./scripts/check-architecture.sh && node scripts/check-framework-ssot.mjs && git diff --check` / 0 | macOS arm64 / Node 22 / Chrome | 40 unit/contract tests + 5 required live E2E + GPT-6 17 组独立内存/HTTP 探针 / 0 | `examples/reference-agent/test/async-executor.test.mjs`、`test/page-race.test.mjs`、`tests/e2e/**` | 证明受控进程内 local effect 的确定性 checkpoint、提交边界、stop 三态、settle、ledger barrier、close 和 UI generation；`emergency` 仅合作取消，不证明线程/进程强停或回滚。完整故障报告矩阵、native effect、真实模型与 mixed-surface 仍属于 `SL-P3-088/089/070`。 |
| `SL-P3-088` | `65adf1865ba02870e706cd394a1dd853ae8e7a87` | `examples/reference-agent/fault-matrix/**`、8 个中文 CaseSpec、browser adapter/engine fault seam、共享 v3 browser options、unit/live report assertions | `npm --prefix examples/reference-agent test && node --test examples/reference-agent/tests/e2e/fault-matrix.e2e.test.mjs && npm --prefix examples/reference-agent run test:e2e && ./scripts/run-framework-p1-tests.sh && ./scripts/check-architecture.sh && node scripts/check-framework-ssot.mjs && git diff --check` / 0 | macOS arm64 / Node 22 / Chrome | 45 unit/contract tests + 2 fault-matrix live tests（8 real Cases + cleanup rejection probe）+ 7 full E2E / 0 | `examples/reference-agent/test/p3-088-fault-matrix.test.mjs`、`tests/e2e/fault-matrix.e2e.test.mjs`、`fault-matrix/specs/**` | 真实 Playwright v3 故障矩阵固定 2 绿 6 红，覆盖跨 callId 业务重复、ledger missing/truncated、stop 三态与 cleanup unconfirmed；预期红不能掩盖额外基础设施故障。effect 仍是受控进程内 local resource；native effect、真实模型、外部服务与 mixed-surface 属于后续任务。 |
| `SL-P4-005` | `20a2ac9c42660253f6de08cdf0f4c782bf3f251b` | `scripts/release/package-graph.mjs`、`scripts/tests/release-contract/plan.test.mjs` | `node --test scripts/tests/release-contract/*.test.mjs && node scripts/run-repository-contract-tests.mjs` / 0 | macOS / Node 22 | 31 release contract tests + 99 repository contracts / 0 | `scripts/tests/release-contract/plan.test.mjs` | optional peer metadata 已进入严格快照、拓扑和版本门禁；仍不 build、sign、生成 SBOM、上传或发布。 |
| `SL-P4-005` | `9a0171386834c5b906d3d6a424641e35697ed85c` | `docs/release/**`、`scripts/release/**`、`scripts/tests/release-contract/**` | `node --test scripts/tests/release-contract/*.test.mjs` + 全模块 `node --check` + schema parse + `git diff --check` / 0 | macOS / Node 22 | 29 adversarial contract tests / 0 | `scripts/tests/release-contract`、`docs/release` | 只交付 plan/final-manifest 与 fail-closed 验证器；不 build、sign、notarize、staple、生成 SBOM、上传或发布；外部上传 TOCTOU 仍需不可变 byte handle/上传点重验。 |

## 12. 变更记录

| 日期 | 决策 |
| --- | --- |
| 2026-09-16 | 主 Agent 与 GPT-6 Xhigh 达成 framework 共识；采用 CaseExecution 中心、可嵌入 kernel、Windows-first native、P1 Agent approval showcase 和 P0–P4 验收路线。 |
| 2026-09-16 | 将生命周期任务拆为 deadline（051）、resource cleanup（052）、worker/stop semantics（053）和最终 kernel integration（050），允许 GPT-6 Xhigh 在互斥目录并行施工。 |
| 2026-09-16 | 完成 P1：真实浏览器审批 showcase、独立完整工具账本、顺序 CLI/逐 Case Reporter 与根验收门禁；显式跨平台 filter 命中 fail closed。 |
| 2026-09-17 | 冻结 `surfaceloom.native/1.0` 协议与 report/v3：副作用 receipt/unknown-no-retry、method intent/scope、multi-host surfaces、最高 ordinal 最终 attempt、保守 v2 import 均有契约回归。 |
| 2026-09-17 | 完成 transport-neutral TS native client 与中性 Windows WPF fixture；Windows host 1.0 双栈实现通过 Docker Release 编译和三轮对抗审查，但在 Windows contract executable 实跑前保持 review。 |
| 2026-09-17 | 完成中性 macOS AppKit fixture 与显式 evidence correlation graph；两个 fixture 都不把 build/model tests 冒充 live AX/UIA，trace correlation 不拥有 verdict。 |
| 2026-09-17 | 在 Windows 11 交互式环境完成 host contract 52/52 与真实 WPF/UIA conformance 5/5（0 skip），关闭 `SL-P2-020` 和 `SL-P2-050`；后续同范围变更必须重跑，不以跨平台编译替代。 |
| 2026-09-17 | GPT-6 Xhigh 逐步审计 P3/P4：明确既有 Windows live 未经过 TS client，拆分协议/cleanup、Node transport、lease、双平台 TS live、runner-v3、作者层和候选/registry 发布门槛；禁止把 close/timeout/kill、截图或手写 revision 冒充资源清理与来源证明。 |
| 2026-09-17 | 首批 5.6 Sol High 实现经主 Agent 回归：关闭事实矩阵同步、macOS `.app` artifact 与 Agent fail-closed 断言；native TS close/late/duplicate-key 加固保持 review，等待 Windows/macOS 跨语言协议证据后再关闭 `SL-P2-060`。 |
| 2026-09-17 | 第二波经 GPT-6 Xhigh 对抗审计和 5.6 Sol High 修正：Windows 严格输入 framing 在真实 Windows 达到 host contract 58/58，并回归 UIA 5/5；据此关闭 TS/C# 范围的 `SL-P2-060`，Swift 共享协议证据仍明确归属 `SL-P3-010`。 |
| 2026-09-17 | `defineProject`、显式配置/Case loader 与兼容 CLI 通过 234 个 package tests，关闭 `SL-P3-075`；interactive-session lease primitive 通过 ABA、PID reuse、异常与 ownership 审计，但尚未接入 native live/mixed GUI，故 `SL-P2-080` 保持 review。 |
| 2026-09-17 | Windows 复验确认 lease 核心跨进程行为 8/8、非软链 storage 对抗 5/5；最初 3 个假失败源于 core/reporter 未先构建导致 test dist 缺失，且 child harness 隐藏 stderr。另 2 个软链安全用例因账户无 symlink 权限被环境阻断，不能计通过；需先加 fail-fast build/child diagnostics，并在具备权限的 Windows runner 0 skip 后再关闭 `SL-P2-080`。 |
| 2026-09-17 | GPT-6 Xhigh 批准启动 `SL-P2-070`、`SL-P3-025`、`SL-P4-005`，并冻结 bounded write admission、Core immutable per-call context、ReleasePlan/最终 ReleaseManifest 分离三项约束；实现交由互斥目录的 5.6 Sol High，exports/manifest/SSOT 由主 Agent 串行集成。 |
| 2026-09-17 | 三项实现经过 GPT-6 Xhigh 多轮反例审计与 5.6 Sol High 返工后关闭：Node transport 分离 process exit/stdio close；DesktopSession cleanup 对 hang、迟到 proof、异常时钟和 borrowed ownership fail closed；release validators 递归核验最终 bytes、容器预算、SBOM 与完整 license evidence。平台 binding/live 和实际发布仍保留为后续任务。 |
| 2026-09-17 | `SL-P3-010/015/055/080` 经 GPT-6 Xhigh 多轮独立反例审计和 5.6 Sol High 修正后关闭：macOS stdio host 对迟到 ownership、cleanup single-flight、断管、terminal write 与 AX IPC deadline fail closed；Case v3 author/evidence/Reporter 对 required artifact、跨 run identity、hostile getter、路径并发与 cleanup deadline 建立不可伪造合同。真实 TS→AX/UIA live、v3 CLI config、P3-086/070 仍按独立任务验收。 |
| 2026-09-18 | 主 Agent 与 GPT-6 Xhigh 重新收紧产品路线：SurfaceLoom 定义为 Agent 行为验证与编排框架，backend 为可替换基础设施；当前优先 M1 高层作者 API→真实 Playwright v3 port→Agent provider→v3 CLI/report，冻结 manifest、通用驱动和 runner 生态扩张。旧 done 与逐任务证据全部保留；P3-030/086 改为聚合门槛，具体交付拆为可独立验收的原子任务。 |
| 2026-09-18 | `SL-P3-090` 经 5.6 Sol High 实现、GPT-6 Xhigh 反例审查与主 Agent 全量回归后关闭：公开包根新增薄 Agent 作者 facade 和最小 Browser backend SPI；非法 lifecycle phase、interval 冒充 named barrier、local effect 冒充 external effect 均在 provider 读取前或完成判定中 fail closed。 |
| 2026-09-18 | `SL-P3-091/092/093` 经三路 5.6 Sol High 实现、GPT-6 Xhigh 多轮对抗审计和主 Agent 整仓回归后关闭：真实 Playwright 进入 v3 surface/cleanup 合同，reference-agent 以原子快照和完整 barrier 提供通用 observation provider，CLI 显式选择现有 v3 kernel 且保持 v2 public TypeScript/runtime 兼容；`SL-P3-094` 转 ready，负责多 Case 一键运行与单一 Reporter v3 bundle。 |
| 2026-09-18 | `SL-P3-094` 经 5.6 Sol High 实现、GPT-6 Xhigh 复审和主 Agent 整仓回归后关闭：一条命令运行真实 Playwright v3 的固定 M1 四 Case 并聚合为单一 Reporter v3 bundle；2 绿 2 红保持业务 exit 1，teardown、cleanup、缺浏览器或发布故障为 infra exit 2 且无 final complete。按本地同信任域模型删除重复磁盘安全验证层，只保留运行身份、附件完整性、异步收尾和发布顺序等工程正确性。 |
| 2026-09-18 | `SL-P0-060` 经 5.6 Sol High 修订、GPT-6 Xhigh 事实复审和主 Agent 静态门禁后关闭：公开 README 将 SurfaceLoom 定义为 Agent 行为验证与测试编排层，Playwright/native/trace 明确为 backend；能力矩阵同步 M1、macOS stdio host 与 Windows 59+5 证据，同时继续区分 declared、contract、live fixture、target app，并禁止把 host contract 或 C# live 扩大为统一 TS native live。 |
| 2026-09-18 | `SL-P3-031` 经 5.6 Sol High 实现、GPT-6 Xhigh 三轮 deadline/ownership/cleanup 反例审计和主 Agent 整仓回归后关闭：公开 `@surfaceloom/native/windows` 与 `/windows/v3`，基础 client 不依赖 test，v3 以 optional peer 接入现有 Case kernel；脚本 host 已覆盖 codec、typed session、late acquisition、unknown/no-retry 和清理闭环，真实 Node→Windows host→WPF/UIA 仍由 `SL-P3-060` 验收。 |
| 2026-09-19 | `SL-P3-087` 经 5.6 Sol High 实现、GPT-6 Xhigh 两轮提交/deadline/settle 反例审计和主 Agent 整仓回归后关闭：reference-agent 的 append-note executor 支持确定性 checkpoint、同步提交边界、合作 stop/emergency 与有界 settle；提交前、提交后未决、effect 已发生分别保留 `notExecuted/unknown/executed`，绝对 deadline 已过但 timer 未投递也不能迟到提交；M1 showcase 继续保持 2 绿 2 红/exit 1。 |
| 2026-09-19 | `SL-P3-088` 经 5.6 Sol High 实现、GPT-6 Xhigh 两轮故障/报告/cleanup 对抗审计和主 Agent 整仓回归后关闭：新增独立 8 Case 真实 Playwright v3 故障矩阵，固定 2 绿 6 红；跨 callId 重复由独立资源 probe 抓住，missing/truncated/open ledger 不满足完整性，stop 三态和 cleanup unconfirmed 保守判定。M1 与矩阵共用一份 browser plan/policy，预期红额外注入 browser close 故障时验收会拒绝，不能吞掉基础设施失败。 |
| 2026-09-19 | `SL-P2-080` 的 execution-wide Windows GUI gate 已在 `af9979c` 合入本地 `main`，并通过 GPT-6 Xhigh 的 stale proof、ABA retirement、提前 contender 与 inherited-pipe 生命周期复审；本地 TypeScript/Swift/架构门禁通过。相同 clean revision 在 Windows 11 复验时，独立 WPF/UIA 继续 5/5、0 skip 且 cleanup 后无残留进程，但默认账户的两个真实 file-symlink storage Case 均以 `EPERM` 失败，因此一键 gate evidence 未生成，任务继续保持 review；未修改 Developer Mode、UAC 或账户权限，也未以 junction 替代。 |
| 2026-09-20 | 主 Agent 与 GPT-6 Xhigh 就 Agent 调用、LLM Judge、Planner 和开源边界达成共识：采用 open-source-first，两项通用能力直接落在 `@surfaceloom/service` 与 `@surfaceloom/llm-judge`；公司仓只注入 Git/runtime/auth/deploy 与产品 adapter。外部 Agent 和本地 Planner 共用同一 MCP/service，Runner 保持唯一执行内核，Judge 只做显式语义判断。新增 A1–A4 与 P5/P6，历史 P0–P4 状态和证据不重写；独立反向审查尚未完成，首批实现任务保持 planned。 |
