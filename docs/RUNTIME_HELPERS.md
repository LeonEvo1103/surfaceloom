# 减少测试接入中的公共代码

本页对应 `SL-P3-095/096/097`，说明第一批通用运行辅助模块的职责。
这些模块组合现有执行能力，不增加组件 manifest 或另一套执行内核。

## 已有库负责什么，SurfaceLoom 负责什么

浏览器启动、DOM 定位和截图继续使用 Playwright。Playwright Test 自己也有
[fixture 生命周期](https://playwright.dev/docs/test-fixtures)和
[超时配置](https://playwright.dev/docs/test-timeouts)。只使用 Playwright Test 的项目，
可以继续使用其原生 fixture；不必为了计时器引入 SurfaceLoom。

当同一个 Case 需要组合浏览器、Agent observation、证据和报告时，SurfaceLoom
负责执行预算、效果授权、资源清理事实与最终报告。原有第三方库通过 backend 或
回调接入，产品 adapter 保留定位器、登录分支和业务预期。

| 需求 | 放置位置 | 复用方式 |
| --- | --- | --- |
| 读取状态，直到条件满足或预算耗尽 | `@surfaceloom/test` | 包装既有 observation 和 deadline 能力 |
| 截图或诊断读取卡住时有界返回 | `@surfaceloom/test` | 注入采集回调，显式传递取消信号与剩余预算 |
| 浏览器启动、清理及报告的重复配置 | `@surfaceloom/browser-playwright/v3` | 生成现有 `runCaseV3` 的配置 |
| 某个产品的登录成功、错误提示、邮件是否到达 | 产品 adapter 与 Case | 业务自己定义，通用模块只负责读取和生命周期 |

## 等待状态与采集诊断

从 `@surfaceloom/test` 导入 `waitForObservationBounded`、
`assertObservationBounded` 和 `captureBoundedDiagnostic`。

`assertObservationBounded` 适合放进现有 `context.criterion()`：条件未满足、读取挂起或
取消时抛出结构化错误，由原执行内核记录失败。`waitForObservationBounded` 返回结构化结果，
适合 adapter 自己区分“读不到”“还没满足”和“预算已到”。两者都保留既有 observation
的可用、缺失、未知和完整性语义。

```ts
await context.criterion("job.completed", () => assertObservationBounded(
  async ({ signal, remainingMs }) => ({
    state: "available",
    value: await adapter.readJobState({ signal, timeoutMs: remainingMs }),
  }),
  {
    expectation: {
      kind: "value", expected: "completed",
      matches: (state) => state === "completed",
    },
    timeoutMs: Math.min(5_000, context.remainingMs()),
    signal: context.signal,
  },
));
```

这里的 `adapter.readJobState` 是消费方提供的只读方法。通用模块不决定某个产品如何
判断完成，也不会调用提交按钮来“再试一次”。

诊断采集同样通过回调接现有库。`captureBoundedDiagnostic` 的回调接收 `signal` 和
`remainingMs()`；把剩余预算交给第三方 API，只有 `captured` 结果包含采集值。
调用者保留原始错误并单独处理诊断结果。超时后底层回调可能仍在写文件，不能把该文件
立即作为完整证据发布，也不能把辅助结果当作已释放资源的证明。

## 浏览器配置只写一次

`@surfaceloom/browser-playwright/v3` 的 `createPlaywrightBrowserRunOptions`
集中创建 backend、surface、host、environment 和 execution plan，返回原有
`RunCaseV3Options`。不用自行实现浏览器关闭或另一套报告发布。

```ts
import { runCaseV3 } from "@surfaceloom/test";
import { createPlaywrightBrowserRunOptions } from "@surfaceloom/browser-playwright/v3";

const result = await runCaseV3(definition, createPlaywrightBrowserRunOptions({
  spec: definition.spec,
  run: { id: runId, title: "浏览器验收", app: { id: "fixture", name: "本地示例" } },
  outputDirectory,
  effects: declaredEffects,
  policy: runnerPolicy,
  browser: { channel: "chrome" },
  signal: cancellationSignal,
}));
```

`definition`、唯一的 `runId`、新输出目录、`declaredEffects` 与 `runnerPolicy`
由调用方提供。效果声明描述 Case 会做什么，运行授权描述当前环境允许做什么，两者分别配置。
完整参数和预算默认值见 [browser package README](../packages/browser-playwright/README.md)。

## 必须保留的行为

等待只重复读取。点击、提交、付款、发送邮件等动作不能放在轮询回调内。
`unknown` 或读取失败不能当作“没有发生”，否定断言仍需 provider 的完整性声明。

等待超时意味着调用者停止等待，并通知支持取消的回调。它不证明底层工作已经停止。
Node 的 [AbortController](https://nodejs.org/api/globals.html#class-abortcontroller)
依赖接收方响应取消；任意同步 JavaScript、忽略信号的第三方操作和独立启动的后台工作
不能靠一个 Promise 超时强制停止。资源释放仍以原有 kernel 的 cleanup receipt 为准。

诊断是附加信息。采集失败应与原测试错误一起保留，不能覆盖原错或生成成功 verdict。
如果某张图片或某份账本是验收必需证据，必须同时走 runner 的 required-evidence
机制，不能因为诊断采集采用尽力而为策略而把缺失证据放行。

截图、trace 与页面内容可能包含敏感数据。辅助模块不自动上传、归档或改写证据保留策略；
采集回调的返回值仍需通过既有 evidence/Reporter 接口及策略处理。

## 本批范围

浏览器配置预设继续使用唯一的 `runCaseV3`，由调用者显式提供效果声明和运行授权。
Case 声明需要某项能力，不代表 runner 已授权它。预设不会自动接受权限或接管用户已打开的浏览器。

目前 v3 浏览器动作接口没有截图动作。通用诊断回调可以接现有浏览器 session 的截图 API，
但这不等于 v3 已提供自动失败截图。本批也不宣称接通真实产品登录、邮箱或原生桌面自动化。

现有 Playwright 依赖及其许可证保持不变；本批不复制第三方实现、不引入新的运行依赖，
也不修改 SurfaceLoom 的 MIT 许可证。

## 运行消费示例

按[入门指南](GETTING_STARTED.md)构建包并安装 reference-agent 的本地依赖后，在仓库根目录运行：

```bash
node examples/reference-agent/recipes/runtime-helpers.mjs
node --test examples/reference-agent/test/runtime-helpers.test.mjs
```

[示例源码](../examples/reference-agent/recipes/runtime-helpers.mjs)用同一套公开 API
读取临时 JSON 文件和本地 HTTP 任务状态；结束后删除临时文件并关闭服务。
测试还覆盖挂起读取、外部取消和诊断失败时保留原始错误。它没有调用外部服务或真实模型，
输出的是辅助模块的观测结果，不是伪造的 Case 报告。

浏览器预设的实际执行例见
[v3 live tests](../packages/browser-playwright/tests/v3-live.test.ts)，完整效果声明与授权
位于同一个文件。预设只有配置职责，执行、清理和 Reporter 仍由原 v3 runner 完成。
