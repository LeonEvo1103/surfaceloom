# SurfaceLoom Reporter

Reporter 是独立的横切包，不是 UI Component。它消费 runner 已经得到的用例结果和证据文件，
生成同一事实源的三种视图：

- `report.json`：版本化、机器可读的权威结果；
- `ai-review.md`：失败优先、附件有序的 AI 验收入口；
- `index.html`：人工查看步骤、错误、截图和录屏。

当前 `surfaceloom.report/v2` 中每条测试是 `{ spec, result }`。`spec` 来自 Core 的
`CaseSpec`，保存中文名称、适用平台、源测试名、原始语义、前置条件和验收条件；`result` 只保存本次状态、
未执行原因、耗时、步骤、错误和证据。HTML 与 AI Markdown 都从这同一结构确定性渲染。

为兼容早期 v2 runner，Reporter 输入仍接受缺少 `spec.platforms` 的 Case；这类输入只会被保守地
归一化为 `[run.platform]`，不会据 tag 推断另一个平台。当前 writer 输出的 v2 始终显式包含非空
`spec.platforms`。新 runner 必须直接提供该字段，兼容分支仅用于读取历史输入。

`complete.json` 最后原子写入并记录三个视图的 SHA-256；`report.json` 另记录每个附件的大小和
SHA-256。消费者必须先验证完成标记与附件；没有完成标记的目录可能来自被中断的写入，不能
作为验收结果。

附件会复制到报告目录，报告只记录相对路径、MIME、大小和 SHA-256，不记录采集源的绝对路径。
默认截图和视频只在失败/超时时保留，trace 和日志始终保留。附件采集失败会记录为
`captureFailed`，不会覆盖原始测试状态。

run 只有在全部用例真正通过时才是 `passed`；存在 `skipped` 或 `unsupported` 时为
`incomplete`。Reporter 还会拒绝“用例 passed、步骤 failed”这类自相矛盾输入，防止 AI 和 CI
读取到假绿结果。Reporter 会验证 `macos`、`windows`、`web` 三个平台维度，并拒绝 Case 声明与
实际 run 平台不一致的输入。

## 运行契约测试

```bash
npm ci
npm test
```

## 生成演示报告

在仓库根目录运行：

```bash
npm --prefix packages/reporter run example -- artifacts/reporter-example
```

演示只生成确定性假数据，不操作桌面。生产 runner 应把真实 screenshot、video、trace、
Accessibility tree 或 diagnostics 作为 `SourceArtifact` 传入 `writeReportBundle`。

视频在 HTML 中使用原生 `<video controls>` 展示。为了让 AI 高效验收，真实录屏还应同时提供
`videoFrame` 关键帧和带语义步骤时间戳的 trace；AI 应先看 JSON、失败截图和关键帧，再按需播放
完整视频。

完整 schema、目录结构、安全策略与平台接入边界见[报告设计](../../docs/REPORTING.md)。
