# SurfaceLoom 框架化 SSOT

> 状态：Active
>
> 当前验收 revision：`2ebc6ccae2ce97e373f09d8abb2c97e9c5755a1a`
>
> 审计日期：2026-09-17
>
> 当前阶段：P1、P2 shared protocol 与 P3 report/v3 已完成；进入 Windows host/client/fixture 并行波次

本文档是 SurfaceLoom 框架执行模型、实施顺序和完成证据的唯一事实源（SSOT）。
`ARCHITECTURE_V2.md` 描述已有分层；两者冲突时，以本文明确列出的新决策为准，并由负责该任务的
集成 PR 同步修正旧文档。规划接口不等于已经实现的能力。

## 1. 产品目标

SurfaceLoom 是面向 Agent 应用的多 surface 自动化测试框架。它在一次可重复执行中关联：

- browser、desktop 与 system surface 上的可见行为；
- Agent run、模型与工具的结构化观察；
- 实际副作用和完整性可验证的 probe/ledger；
- Case 验收条件、动作提交语义、诊断和证据。

框架的中心对象是 `CaseExecution`，不是 `Page`、`Driver` 或万能 `Element`。普通应用测试只依赖
基础 Case、surface、fixture、assertion 和 Reporter，不强制加载 Agent fixture。

第一条代表性闭环是：确定性模型请求一次工具操作，UI 显示审批，拒绝后 Agent run 结束，独立
工具账本证明该 run 的完整观察区间内执行次数为零；批准变体必须证明恰好执行一次。

## 2. 已冻结架构决策

### 2.1 统一边界

统一 Case/attempt、资源 ownership、fixture、deadline/cancellation、capability negotiation、
effect policy、step/assertion/criterion、结构化错误、证据关联、cleanup 和最终 verdict。

保留 surface 差异：DOM click/fill/navigation/network、AX/UIA invoke/setValue/window/menu 和
system dialog 不伪装成同一种低层动作；DOM、AX、UIA locator 与 role 维持强类型差异。

### 2.2 作者与扩展者

- 业务 Case 优先调用产品 adapter 暴露的语义行为和 observation。
- adapter/component 作者使用 typed surface primitives 与低层 query/action。
- backend 实现 Core surface contract 和 capability，不把原生对象暴露给 Case。
- Agent run、model fixture 和 tool probe 是资源/观察源，不伪装成 UI surface。
- Reporter、TraceAdapter 和 viewer 只消费结果/证据，不反向操作 UI。

### 2.3 Runner

SurfaceLoom 拥有可嵌入 execution kernel。`sl test` 是官方 front-end，但不是唯一入口；未来
`node:test`、Jest 或内部 kit 集成必须调用同一 kernel，不能绕过 policy、cleanup 或结果校验。

首版 CLI 只负责发现、过滤、顺序执行、timeout、报告和 exit code；worker pool、sharding、
watch、分布式调度和通用插件市场不在 P1 范围。

### 2.4 Native 顺序

Native 路线固定为 Windows → macOS：从已有 Windows NDJSON 0.2 行为提取最小共享协议，先实现
Windows TypeScript client 与真实 Windows fixture conformance，再由 macOS stdio host 实现同一
协议。Windows 0.2 不是直接冻结的跨平台标准。

### 2.5 动作与断言

- observation 可以轮询，动作 dispatch 不自动重放。
- 动作结果至少区分 `notExecuted`、`executed`、`unknown`；断线且无可信 receipt 时为 unknown。
- assertion 必须重新读取 observation，并记录 expected/actual/deadline/criterion/evidence。
- 负断言必须有完整观察区间或完成 barrier；缺少事件、截断 trace 或读取失败不等于零次。
- 只有全部必需 criterion 通过且 cleanup 完成，Case 才能 passed。
- 后续 teardown/证据错误不得覆盖更早的正文失败，但必须改变最终运行状态并保留全部原因。

## 3. 包拓扑

| 包 | 权威职责 |
| --- | --- |
| `@surfaceloom/core` | 无 backend 依赖的 Case、fixture、surface、capability、effect、observation 契约 |
| `@surfaceloom/test` | execution kernel、作者 API、CLI、自动等待断言、资源协调；P1 新增 |
| `@surfaceloom/native` | TS native client、host 启动和 wire compatibility；P2 新增 |
| `@surfaceloom/browser-playwright` | 可选 browser backend，不成为 Core/native 的依赖 |
| `@surfaceloom/reporter` | canonical result 校验、证据归档和视图，不依赖 backend |
| `@surfaceloom/agent-loop` | trace 导入、归一和展示，不承担运行或 authoritative verdict |
| `@surfaceloom/component-catalog` | 组件/fixture manifest 目录，不把声明冒充行为实现 |

P1 只新增 `@surfaceloom/test`。协议 schema/golden vectors 先随 `@surfaceloom/native` 管理，不单独
创建 protocol 包。形成第二个真实消费者前，不新增通用 Agent testing 包。

## 4. 首版执行契约

`CaseSpec` 继续表达长期不变的测试语义；`ExecutionPlan` 表达本次执行资源，二者分离：

```ts
interface ExecutionRequirements {
  host?: { os: readonly ("macos" | "windows" | "linux")[] };
  surfaces: Readonly<Record<string, {
    kind: "browser" | "desktop" | "system";
    capabilities: readonly string[];
  }>>;
}

interface EffectDescriptor {
  resource: string;
  operation: "read" | "write" | "execute";
  boundary: "local" | "external";
  securitySensitive: boolean;
  recovery: "notNeeded" | "resettable" | "unknown";
}
```

现有 `CaseSpec.platforms` 与 `sideEffect` 保持兼容，不把 OS、surface 和 Agent 混入同一个枚举。
P1 不向严格的 CaseSpec 或 report/v2 静默增加字段；ExecutionPlan 暂由 `packages/test` 管理。
新 effects 存在时必须不超出旧摘要；旧 enum 不能被伪造为具体资源或恢复保证。

`executeCase(definition, options)` 返回可转换为 Reporter `CaseReportInput` 的逐 Case 结果。第一波
复用现有 CaseSpec、FixtureRuntime 和 report/v2 输入，不宣称已经解决任意不合作 JavaScript 的
强制取消；该问题由 `SL-P1-050` 单独验收。

工具账本使用稳定 `runId`/`callId`，区分 requested/started/completed。Agent fixture 必须提供
run 完成边界和 ledger completeness；一次空快照不构成零调用证据。

## 5. 执行状态机

```text
discover → validate → plan → acquire leases → setup fixtures
         → execute steps/assertions → finalize evidence
         → reverse cleanup → validate result → publish
```

结果保留原始失败、清理失败、证据失败和动作未知状态。共享桌面焦点、输入、剪贴板等资源必须用
跨进程 interactive-session lease；browser isolated context 可按资源隔离能力并行。

## 6. 阶段门槛

| 阶段 | 唯一主要闭环 | 完成门槛 | 非目标/停止条件 |
| --- | --- | --- | --- |
| P0 | 可审阅、可执行的框架契约 | SSOT、事实矩阵、账本检查器和旧文档入口一致 | 新接口文字不算实现 |
| P1 | Agent 审批 Case 从作者入口到可信报告 | browser + 确定性 model/tool fixture；拒绝 0、批准 1、故障注入失败；普通 Case 不加载 Agent fixture | 不做 native parity、sharding、真实模型评分 |
| P2 | TS → Windows host → fixture app → 报告 | 共享协议、Windows client、真实交互式 conformance；错误和 ownership 覆盖 | 无 Windows live 证据即 blocked，fake 不替代 |
| P3 | 同一执行语义跨 native 平台与多 surface | macOS 同协议 conformance；一个 browser + native/system Case；report/v3 保留 surface/attempt | 不要求全部 manifest 双平台实现 |
| P4 | 仓库外消费者独立安装和接入 | 无源码树偶然依赖；启动 host、运行参考 Case、实现外部 adapter、生成报告 | 安装/制品不闭合不发布；不承诺 1.0 |

## 7. 任务状态和完成证据

状态只允许：`planned → ready → in_progress → review → done`，或从 `in_progress` 转为 `blocked`。
实现 Agent 只能提交到 review；主 Agent 验收后才能置 done。

done 记录至少包含：taskId、sourceRevision、changedPaths、command、exitCode、platform、
executedTests、skippedTests、evidencePath、remainingLimitations。源码存在、manifest 声明、fake
contract 和 live conformance 必须分别记录；默认跳过的 smoke 不算完成证据。

## 8. 原子任务账本

### P0：框架契约

| ID | 状态 | 依赖 | 排他写入范围 | 产物与 DoD |
| --- | --- | --- | --- | --- |
| `SL-P0-001` | done | — | `docs/FRAMEWORK_SSOT.md` | 本文档；任务 ID/依赖/第一波接口无冲突，`git diff --check` |
| `SL-P0-010` | done | `SL-P0-001` | `docs/framework/capabilities.md` | 逐项链接源码、测试、验证级别；明确 manifest/实现、bridge/contract/live 差距 |
| `SL-P0-020` | done | `SL-P0-001` | `scripts/check-framework-ssot.mjs`、对应 tests | 校验 ID、依赖、环、状态和 done 证据；不做调度系统 |
| `SL-P0-030` | done | `SL-P0-001`,`SL-P0-010` | README、AGENTS、`ARCHITECTURE_V2.md` | 增加 SSOT 入口并修正冲突，不把规划写成已实现 |

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
| `SL-P2-020` | ready | `SL-P2-010` | `native/windows-host/**` | host 对齐协议且明确 0.2 兼容/停用策略，unknown 不重发 |
| `SL-P2-030` | ready | `SL-P2-010` | native TS client/transport/tests | host 生命周期；错误版本、断线、超时、stale session、payload 边界 |
| `SL-P2-040` | ready | `SL-P2-010` | 新 `native/windows-fixture/**` | 中性 UIA app：invoke/setValue/歧义/消失元素/owned lifecycle |
| `SL-P2-050` | planned | `SL-P2-020`,`SL-P2-030`,`SL-P2-040` | Windows live tests/scripts/workflow | 真实 conformance，记录 OS/host/revision/Case 数，禁止全 skip |

### P3：macOS 与 multi-surface

| ID | 状态 | 依赖 | 排他写入范围 | 产物与 DoD |
| --- | --- | --- | --- | --- |
| `SL-P3-010` | planned | `SL-P2-010`,`SL-P2-050` | Package.swift、新 macOS host/tests | 同协议 stdio host，复用现有 AX/ownership，不新造 wire 语义 |
| `SL-P3-020` | ready | `SL-P2-010` | 新 macOS fixture | 与 Windows 同一行为契约的中性 app |
| `SL-P3-030` | planned | `SL-P3-010` | native package macOS binding/tests | typed desktop session 和显式平台专属 capability |
| `SL-P3-040` | done | `SL-P1-080` | reporter package | report/v3 host/surface/attempt 和 v2 importer；不静默降级 |
| `SL-P3-050` | ready | `SL-P3-040` | Core evidence context、agent-loop/tests | 显式 correlation；时间相邻不冒充因果，trace 不改 verdict |
| `SL-P3-060` | planned | `SL-P3-010`,`SL-P3-020`,`SL-P3-030` | macOS live tests/scripts/CI | 同一行为集真实 conformance；TCC 不足明确报告且不自动授权 |
| `SL-P3-070` | planned | `SL-P2-050`,`SL-P3-040`,`SL-P3-050`,`SL-P3-060` | mixed-surface example 与 lease tests | browser + native Case，跨面动作、证据、租约和清理，报告列两面 |

### P4：可安装 alpha

| ID | 状态 | 依赖 | 排他写入范围 | 产物与 DoD |
| --- | --- | --- | --- | --- |
| `SL-P4-010` | planned | `SL-P3-070` | package manifests、native 制品脚本、兼容说明 | 无 `file:` 发布依赖，host 版本/OS/arch 可核验，制品扫描 |
| `SL-P4-020` | planned | `SL-P4-010` | packed-consumer script/fixture | 仓库外安装运行参考 Case 并生成报告，不访问源码树 |
| `SL-P4-030` | planned | `SL-P4-020` | 外部 adapter example、conformance、release notes | 小型自有 adapter 接入；扩展点、版本和验证范围一致 |

## 9. 并行施工规则

下一并行波次为：`SL-P2-020`、`SL-P2-030` 与 `SL-P2-040`。三者分别独占 Windows host、
native TS client 和 Windows fixture；不得修改 SSOT、根 scripts/CI、共享 exports 或现有 execution
kernel。共享接线仍由主 Agent 集成。P3 macOS fixture 与 evidence correlation 已 ready，但等待本波次
释放并发位后再施工。

即使源码目录互斥，`core/dist` 等生成物仍共享。实现 Agent 只运行 scoped typecheck/test；主 Agent
串行运行全量构建。`packages/*/src/index.ts`、package manifest/lock、Package.swift、Reporter
schema 和根 CI 始终指定单一集成人。

## 10. 扩展与版本边界

P1 alpha 可开放 product adapter、fixture provider、observation/probe、完成后的 report 消费接口，
以及已有 TraceAdapter。Backend SPI 在官方 browser/native conformance 后再承诺第三方兼容；
任意生命周期 hook、全局 service container、scheduler interception 和 AI evaluator 暂不开放。

npm 包、native wire protocol、report schema、trace schema 和 component behavior/manifest 分别版本化。
平台支持必须标明 declared、contract-tested、live-fixture-tested 或 target-app-tested；没有 live 证据
只能写 contract-tested。

## 11. 验收记录

| taskId | sourceRevision | changedPaths | command / exitCode | platform | executed / skipped | evidencePath | remainingLimitations |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SL-P0-001` | `0230973e9539838f9393509b7b32681fde4c2c1b` | `docs/FRAMEWORK_SSOT.md` | `git diff --check` / 0 | macOS | 1 document contract / 0 | `docs/FRAMEWORK_SSOT.md` | 账本自动检查器由 `SL-P0-020` 交付；规划能力均未计为实现。 |
| `SL-P0-020` | `aebb24c43af1c664f39bce9ab0b705c517a1d0c2` | `scripts/check-framework-ssot.mjs`、`scripts/lib/framework-ssot.mjs`、`scripts/tests/framework-ssot.test.mjs` | `node --test scripts/tests/framework-ssot.test.mjs && node scripts/check-framework-ssot.mjs` / 0 | macOS | 2 tests / 0 | `scripts/tests/framework-ssot.test.mjs` | 只验证账本结构，不调度任务，也不替代人工能力证据审查。 |
| `SL-P0-010` | `aebb24c32f3dec0e7b51c369656cd2d27430dabb` | `docs/framework/capabilities.md` | `node` 本地链接检查与 `git diff --check` / 0 | macOS | 75 links（65 unique targets）/ 0 | `docs/framework/capabilities.md` | 无 target-app 证据；browser live smoke 未执行；macOS/Windows 仍缺统一 TS native bridge 和中性 fixture live conformance。 |
| `SL-P0-030` | `dc1e6c67ae6d88e069f74efe1dc3091e120c7a1c` | `README.md`、`AGENTS.md`、`docs/ARCHITECTURE_V2.md` | `node scripts/check-framework-ssot.mjs && ./scripts/check-architecture.sh && git diff --check` / 0 | macOS | 2 contract checks / 0 | `README.md`、`AGENTS.md`、`docs/ARCHITECTURE_V2.md` | 只统一权威入口与事实措辞；未把 execution 规划计为实现。 |
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
| `SL-P3-040` | `2ebc6ccae2ce97e373f09d8abb2c97e9c5755a1a` | `packages/reporter/src/v3/**`、`tests/v3/**`、公开 export | `npm run typecheck && npm test && npm pack --dry-run` / 0 | macOS / Node 22 | 18 v3 tests（54 reporter total）/ 0；111 packed files | `packages/reporter/tests/v3` | CLI 仍输出 report/v2；v3 需要 runner 提供真实 host/surface/attempt/executionPlatforms，不自动伪造。 |

## 12. 变更记录

| 日期 | 决策 |
| --- | --- |
| 2026-09-16 | 主 Agent 与 GPT-6 Xhigh 达成 framework 共识；采用 CaseExecution 中心、可嵌入 kernel、Windows-first native、P1 Agent approval showcase 和 P0–P4 验收路线。 |
| 2026-09-16 | 将生命周期任务拆为 deadline（051）、resource cleanup（052）、worker/stop semantics（053）和最终 kernel integration（050），允许 GPT-6 Xhigh 在互斥目录并行施工。 |
| 2026-09-16 | 完成 P1：真实浏览器审批 showcase、独立完整工具账本、顺序 CLI/逐 Case Reporter 与根验收门禁；显式跨平台 filter 命中 fail closed。 |
| 2026-09-17 | 冻结 `surfaceloom.native/1.0` 协议与 report/v3：副作用 receipt/unknown-no-retry、method intent/scope、multi-host surfaces、最高 ordinal 最终 attempt、保守 v2 import 均有契约回归。 |
