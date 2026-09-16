# @surfaceloom/test

可嵌入的最小 Case 执行内核，对应框架任务 `SL-P1-010`。当前验证级别为
**contract-tested**；不代表 browser/native 的真实交互式 conformance。

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
失败步骤即使被正文捕获也会阻止通过。必须覆盖所有验收条件，并完成清理，才能得到 `passed`；
空正文或只记录动作会因缺少验收而失败。

Reporter v2 不增加字段：最早观察到的错误保存在 `result.error`，每个失败阶段/步骤的
`diagnostic` 包含 JSON `{ category, errors }`，保留后续错误。Core 的 setup/rollback
`AggregateError` 按其原始顺序展开，首个 setup 错误不会被 rollback/teardown 覆盖。
错误属性无法安全读取时使用明确 fallback，不让 message/name/errors getter 的异常中断清理。
循环错误、安全读取失败、超过 32 层或 1000 个错误节点的诊断会明确标记，避免无界展开。
生命周期和自动 criterion 步骤使用保留的 `kernel.` ID 前缀。最终结果由 Reporter 自身验证；
内部验证 envelope 不作为实际 run 发布。上层报告 run 的时间区间应包含整个 executeCase 调用。

## 当前边界

本包尚无 CLI、发现/过滤器、browser/native adapter、自动等待 assertion、observation 轮询、
deadline、强制取消、跨进程资源租约、capability 预检、policy/effects 门禁或证据采集。
`platform` 只验证报告平台与 CaseSpec 一致，`sideEffect` 只是声明，前置条件不会自动执行。
调用方必须自行确保环境与副作用已获准；本包还不能作为这些能力的安全边界。

永不完成的 setup、正文、步骤或 teardown 会令执行一直等待。没有 `Promise.race` 超时或
“已经停止”的保证；脱离上下文 API 的异步任务不受追踪。返回的上下文方法会拒绝迟到调用，
但不能撤销 fixture 已返回给正文的对象，也不能停止外部副作用。隔离与取消由后续
`SL-P1-050` 验收。当前仅产生 `passed`/`failed`，不声称支持 timedOut/skipped/unsupported 调度。
fixture 快照固定定义和函数引用，不冻结回调闭包中的外部状态或返回的资源对象；不返回的恶意
getter 与其他不合作 JavaScript 一样，不能由此内核强制终止。

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
