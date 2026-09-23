# @surfaceloom/test

可嵌入的 Case 执行内核与最小顺序 CLI，对应框架任务 `SL-P1-010` 至 `SL-P1-070`。
内核与 CLI 当前为 **contract-tested**；reference-agent 另有真实浏览器 fixture E2E，仍不代表
native backend 的真实交互式 conformance。

## 作者入口

```ts
import assert from "node:assert/strict";
import { defineFixture } from "@surfaceloom/core";
import { CaseRegistry, defineCase, executeCase } from "@surfaceloom/test";

const value = defineFixture({
  id: "example.value",
  setup: () => ({ value: 42, teardown: () => undefined }),
});

const example = defineCase({
  spec: {
    id: "example.value-case",
    locale: "zh-CN",
    platforms: ["web"],
    suite: { id: "example.contract", name: "示例契约" },
    name: "读取 fixture 并验证结果",
    intent: "演示验收条件与执行结果的关联。",
    preconditions: [],
    acceptanceCriteria: [{ id: "correct-value", text: "读取到预期值。" }],
    sideEffect: "readOnly",
  },
  fixtures: [value],
  run: async (context) => {
    await context.step({ id: "read", title: "读取测试值" }, async () => {
      await context.criterion("correct-value", () => {
        assert.equal(context.fixture(value), 42);
      });
    });
  },
});

const registry = new CaseRegistry([example]);
const reportCase = await executeCase(registry.require("example.value-case"), {
  platform: "web",
});
// reportCase 可直接放入 Reporter 的 ReportBundleInput.tests。
```

- `defineCase` 复用 Core 的 `defineCaseSpec` 验证并冻结定义；fixture 列表与执行函数不进入 CaseSpec。
  fixture 及其依赖通过 Core `defineFixture` 保存冻结快照；注册后修改原对象的 setup、id、scope
  或依赖数组不改变已注册定义。依赖循环在定义阶段拒绝。setup 的 `context.get()` 和正文的
  `context.fixture()` 保留对原 fixture 对象的身份引用，仍由 Core 拒绝未声明的依赖读取。
- `CaseRegistry` 以稳定 Case ID 显式注册，拒绝重复 ID，`list()` 保留注册顺序；没有全局注册状态。
- `executeCase(definition, { platform })` 返回 `NormalizedCaseReportInput`，可直接赋给
  Reporter 的 `CaseReportInput`。非法定义或不匹配的平台在 setup 前拒绝；执行失败返回失败结果。
  platform 在入口读取一次，执行中修改 options 不会改变最终报告验证的平台。
- `context.fixture(definition)` 读取 Case 显式列出的 fixture；依赖仍由 Core 负责解析。
- `context.step({ id, title, criterionIds? }, body)` 执行一次，记录耗时、结果与验收关联，返回回调值。
  `context.criterion(id, check)` 用验收条款原文生成步骤。回调必须通过抛错表达失败；返回 `false`
  不代表断言失败。两者都应 `await`，不会重试动作或重新读取 observation。

## 生命周期和结果

每次执行独占一个 Core worker scope 及其 test scope；按声明顺序 setup，依赖由 Core 排序，
按逆序清理 test scope 后再清理 worker scope。worker fixture 仅在本次执行中复用，不跨 Case
共享。setup 失败不执行正文，并保留 Core 的依赖回滚；一个 teardown 失败仍会继续其余清理。
setup 自己在返回资源前获得的未注册资源，仍由 fixture provider 负责回滚。

所有被调用的 step/criterion 都等待完成后才清理 fixture，包括正文提前失败时尚未完成的步骤。
通过 `context.dispatch()` 启动的授权动作也进入同一 drain；即使作者漏写 `await`，迟到失败仍会
被记录。`context.registerResource()` 明确登记 owned/borrowed 资源，owned 资源按逆序清理，
并要求显式 `released` 或 `unconfirmed` 回执。失败步骤即使被正文捕获也会阻止通过。
必须覆盖所有验收条件，并完成清理，才能得到 `passed`；空正文或只记录动作会因缺少验收而失败。

整个 setup、正文、pending step/action 和 cleanup 默认共享 30 秒生命周期 deadline，可用
`timeoutMs`、`cancellationGraceMs` 和外部 `signal` 配置。Case 可通过 `context.signal`、
`throwIfCancelled()` 与 `acknowledgeCancellation()` 合作停止。deadline 到达会返回 `timedOut`；
只有回调真实 settle 后才会记录 `cooperativeStopped`，单纯结束等待不会冒充任务已停止。
cleanup 中已确认的 outcome 和尚未处理的 `remaining` 资源都会进入 `kernel.cleanup` diagnostic；
迟到注册即使被 provider 捕获，也会留下 sticky taint 并阻止绿色结果。

Reporter v2 不增加字段：最早观察到的错误保存在 `result.error`，每个失败阶段/步骤的
`diagnostic` 包含 JSON `{ category, errors }`，保留后续错误。Core 的 setup/rollback
`AggregateError` 按其原始顺序展开，首个 setup 错误不会被 rollback/teardown 覆盖。
错误属性无法安全读取时使用明确 fallback，不让 message/name/errors getter 的异常中断清理。
循环错误、安全读取失败、超过 32 层或 1000 个错误节点的诊断会明确标记，避免无界展开。
生命周期和自动 criterion 步骤使用保留的 `kernel.` ID 前缀。最终结果由 Reporter 自身验证；
内部验证 envelope 不作为实际 run 发布。上层报告 run 的时间区间应包含整个 executeCase 调用。

## 自动 observation 与 assertion

`assertObservation` 每次重试都会重新调用 reader，不接受已经求值的 snapshot 或 Promise。
`unknown`、`read-failed` 与 `absent` 是不同状态；否定断言还必须由 provider 给出完整观察边界，
不能把短暂空结果当成“从未发生”。

```ts
import { assertObservation, observationAvailable } from "@surfaceloom/test";

await context.criterion("run-completed", () =>
  assertObservation(
    async () => observationAvailable(await agent.readRun()),
    {
      criterionId: "run-completed",
      expectation: { kind: "matches", predicate: (run) => run.state === "completed" },
      timeoutMs: 5_000,
    },
  ),
);
```

超时使用单调时钟，迟到的 read 不能反过来通过 deadline。失败诊断会保留 expected、actual、
最后一次有效 observation、最后一次读取错误、deadline、criterion 与 evidence，并通过标准
`context.criterion` 写入 Reporter 的结构化 diagnostic。

### 有界 observation 与诊断采集

`waitForObservationBounded` 在现有 observation 语义外增加一个覆盖全部轮询和单次 reader 的总
deadline。reader 额外收到同一个 `AbortSignal`，并在每次调用时收到当前 `remainingMs`；取消或
超时后不会再次调用真实 reader。`assertObservationBounded` 返回相同回执，只有非 `passed` 时抛出
带 `.result` 的 `BoundedObservationAssertionError`。原有 `waitForObservation` 与
`assertObservation` 保持不变，适用于调用方已经能保证 reader 自身有界的场景。

```ts
import {
  assertObservationBounded,
  captureBoundedDiagnostic,
} from "@surfaceloom/test";

await assertObservationBounded(
  ({ signal, remainingMs }) => ledger.read({ signal, timeoutMs: remainingMs }),
  {
    expectation: {
      kind: "negative-value",
      expected: 0,
      matches: (count) => count === 0,
      completeness: { kind: "barrier", id: "run.done" },
    },
    timeoutMs: 5_000,
  },
);

const diagnostic = await captureBoundedDiagnostic(
  ({ signal, remainingMs }) => screenshotBytes({ signal, timeoutMs: remainingMs() }),
  { timeoutMs: 1_000 },
);
if (diagnostic.status === "captured") {
  // 调用方再把 diagnostic.payload 交给 Reporter 或自己的 artifact store。
}
```

有界 observation 继续复用原 matcher：`unknown`、`read-failed` 和不完整的负观察不能通过，reader
只允许读取，不应派发 action。回执区分 `timedOut`、`cancelled`、`clockFailed` 与普通失败，并用
`stopStatus` 说明 callback 是否实际 settle。`unconfirmed` 表示仍可能有同进程工作；JavaScript
deadline 无法强停一个忽略 signal 的 Promise、同步死循环或 callback 启动的 detached 工作。

`captureBoundedDiagnostic` 只做 best-effort callback 管理：成功分支才包含 `payload`，普通异常以
`failed + cause` 返回，方便调用者继续保留原始 Case 错误。它不发布或删除 artifact，不会把仍在写入
的文件当成已清理，也不参与 Case verdict。优先让 callback 在内存中采集有界 bytes，再由 Reporter
或调用方在 `captured` 后归档；timeout/cancel 后不要使用迟到 payload。

## ExecutionPlan 与 effect policy

`defineExecutionPlan` 声明 Case 所需 host、surface、capability 和精确 effect；
`preflightExecution` 在副作用前做能力与授权检查，`ExecutionPolicyGate.dispatch` 保证被拒绝的
回调零次执行、获准回调只调度一次。外部影响、安全敏感操作、未知恢复方式都需要独立显式授权，
旧 `sideEffect` 只作为粗粒度上限，不能伪装成精确资源声明。

```ts
import {
  defineEffect,
  defineExecutionPlan,
  preflightExecution,
} from "@surfaceloom/test";

const readEffect = defineEffect({
  resource: "fixture.output",
  operation: "read",
  boundary: "local",
  securitySensitive: false,
  recovery: "notNeeded",
});
const plan = defineExecutionPlan({
  spec: example.spec,
  requirements: {
    host: { os: ["macos", "windows", "linux"] },
    surfaces: { page: { kind: "browser", capabilities: ["browser.dom.inspect"] } },
  },
  effects: [readEffect],
});

const environment = {
  platform: "web" as const,
  host: { os: "macos" as const },
  surfaces: { page: { kind: "browser" as const, capabilities: ["browser.dom.inspect" as const] } },
};
const policy = {
  maximumSideEffect: "readOnly" as const,
  grants: [{ resource: "fixture.output", operations: ["read" as const] }],
};

// 独立调用时可显式 preflight；executeCase 内部也会在创建 fixture runtime 前执行同一门禁。
const gate = preflightExecution(plan, environment, policy);
await gate.dispatch(readEffect, async () => 42);

await executeCase(example, {
  platform: "web",
  plan,
  environment,
  policy,
  timeoutMs: 5_000,
});
```

`executeCase` 要求 plan 的完整 CaseSpec 与执行定义一致，并要求 environment platform 与报告平台一致；
不匹配、缺 capability 或 effect 未授权都会在创建 fixture runtime 和调用 setup 前失败。Case 内的动作
应走 `context.dispatch(effect, action)`，以复用已经预检的 gate 并进入生命周期 drain。

## 顺序 Suite 与 CLI

`executeCaseSuite` 是 CLI 和嵌入调用共享的顺序执行入口。它发现并筛选 Case 后，逐个调用同一个
`executeCase` kernel；某个 Case 失败不会阻止后续 Case。`runCaseSuite` 再把逐 Case 结果交给
Reporter v2 生成 `report.json`、HTML 与 AI review。能力缺失记录为 `unsupported`，执行策略未授权
记录为 `skipped`，两者都不会产生绿色退出码。

编译后的 JavaScript Case 模块需导出 named `cases` 或等价的 default 数组/`CaseRegistry`：

```bash
sl-test \
  --platform web \
  --output artifacts/case-run \
  --case-id example.value-case \
  ./cases
```

CLI 退出码为：全部 Case 通过时 `0`，任一 `failed`、`timedOut`、`skipped` 或 `unsupported` 时
`1`，参数、发现或报告写入错误时 `2`。当前只发现 `*.case.js`、`*.case.mjs` 与 `*.case.cjs`；
TypeScript Case 应先由调用方编译。未提供 ID/filter 时，Suite 按 `--platform` 分区；显式 ID 或
filter 一旦命中不支持该平台的 Case，整次运行会在任何 Case 执行前拒绝，避免静默漏测后假绿。

## 当前边界

本包尚无并行 worker pool、sharding、watch、browser/native adapter、跨进程资源租约或自动证据采集。
前置条件不会自动执行。kernel 直接产生 `passed`、`failed` 和 `timedOut`；Suite 层只把明确的
capability 缺失映射为 `unsupported`、明确的 policy 拒绝映射为 `skipped`，其他入口异常保持失败。

生命周期 deadline 能有界结束对异步 setup、正文、step/action 和 cleanup 的等待，但 timeout
不等于底层工作已经停止。合作取消需要 signal acknowledgment 与真实 settlement；非合作的
in-process 异步任务会明确返回 `unconfirmed + tainted`。同步死循环会阻塞 JavaScript event loop，
无法由本进程内 deadline 抢占；脱离 context API 的 detached 工作也不受追踪。真实强制终止只适用于
调用方 owned 的 Node Worker，并要求 `terminate()` 与实际 exit 事件双回执，仍不能证明外部副作用已回滚。

返回的上下文方法会拒绝迟到调用，但不能撤销 fixture 已交给正文的对象。partial cleanup 会保留
已完成 outcome 和 remaining 资源，不能当成 released。fixture 快照固定定义和函数引用，
不冻结回调闭包中的外部状态或返回的资源对象；不返回的恶意 getter 与其他不合作 JavaScript 一样，
不能由此内核强制终止。policy gate 是调用前授权边界，不是 JavaScript sandbox；回调启动后的
外部副作用仍需由 ownership、取消、独立 ledger 与清理协议约束。

## 本地验证与打包

此包暂为 `private`，使用 `file:../core` 和 `file:../reporter`。先由仓库集成流程顺序构建这两个
依赖，再运行下列 scoped 命令。本包的 build/test 不会重新构建依赖，避免并行写入共享 dist。

```bash
npm --prefix packages/test ci
npm --prefix packages/test run typecheck
npm --prefix packages/test test
```

build 复用仓库清理与许可证脚本，只写本包 `dist`，并将根 MIT LICENSE 复制到 `dist/LICENSE`。
发布内容限于 dist 与 npm 自动包含的 README/package.json；独立安装与取消 `file:` 依赖属于 P4。
