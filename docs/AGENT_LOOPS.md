# Agent loop 轨迹与可视化

Agent 应用的失败通常跨越多个边界：模型生成计划、工具执行、浏览器 DOM、原生窗口、权限审批和
最终证据。只看截图或某一种 runtime 日志无法解释完整因果链。SurfaceLoom 使用一个产品无关的
`surfaceloom.agent-loop/v1` schema 把这些事件放在同一时间轴上。

## 统一模型

每个事件只保留可验证的结构信息：

- `lane`：`agent`、`model`、`tool`、`approval`、`desktop`、`browser` 或 `system`；
- `phase`：`start`、`finish` 或 `instant`；
- `offsetMs` 与可选 `durationMs`；
- `correlationId`：在同一来源内关联同一操作的开始/结束事件；
- `status`、事件名、脱敏后的安全 metadata。

统一 schema 不保存原始 prompt、完整消息、reasoning、工具参数/输出、用户目录或凭据。需要保留
原始 trace 时，应把它作为受限证据单独保存，不应嵌入可分享的 viewer。

## Adapter 边界

`TraceAdapter` 只有 `detect` 和 `import` 两个方法。内置 adapter：

| 格式 | 输入 | 归一重点 |
|---|---|---|
| Codex | rollout JSONL | turn、message、reasoning、tool call/output、usage |
| SurfaceLoom | core trace JSONL | 原生/浏览器 operation、diagnostic、attachment |

第三方 adapter 可以接入 OpenTelemetry span、其他 Agent SDK 或自定义事件总线。渲染器只依赖统一
schema，不随输入格式增加分支。产品或公司专用格式放在独立 package，通过
`@surfaceloom/agent-loop/adapter-sdk` 的正式 exports 接入。

`correlationId` 在 v1 只表达同源事件分组，不承诺完整父子 span 或跨来源因果关系。第三方 adapter
代码属于受信任扩展边界，但其输入不可信；adapter 返回值仍会经过版本、字段、大小和统一脱敏校验。

自动检测使用 `0..100` 置信度；没有匹配或最高分并列都会失败。导入器限制输入大小、事件数和
metadata 深度，对不完整的流式 JSONL 尾行安全降级，并为丢弃事件产生 warning。

## 多来源合并

`mergeAgentLoopTraces` 在所有来源都有 `startedAt` 时按绝对时钟对齐；任一来源没有可靠时钟，
则保留各自相对 offset 并写入 warning。事件 ID 与 correlation ID 在合并时增加来源命名空间，
避免不同 runtime 的 ID 碰撞。

## Viewer

`renderAgentLoopHTML` 输出单文件静态 HTML：

- 无 JavaScript、网络请求或外部字体；
- CSP 默认拒绝所有资源，只放行内联样式 hash；
- lane 时间线用于观察跨 surface 顺序，ledger 展示确定性事件明细；
- 所有文本经过 HTML escaping；viewer 会再次归一化输入，只展示结构化标识和 metadata 存在性，
  不直接展示 summary、warning 正文或 metadata 值。

`renderAgentLoopListHTML` 面向测试集总览：按输入顺序列出多个 case，展示最终状态、历史失败或
阻塞计数、紧凑泳道，并允许在页面内展开每个 case 的事件明细。CLI 重复传入 `--input` 即自动
切换到 list viewer；单输入行为保持不变。大批次的 case 索引默认折叠，单 case 的缩略时间线和
ledger 使用确定性采样并优先保留失败/阻塞事件；完整事件仍由 single-case viewer 提供。

CLI 的 `--input-dir` 会递归发现 trace/rollout 文件并逐个自动识别 adapter，一次生成 list viewer。
发现过程不跟随符号链接，限制扫描深度、目录项和候选文件数量；无法识别的候选文件只形成脱敏的
批次 warning，不会把源路径写入 viewer。显式 `--input` 保持 fail-closed。

Reporter 可以把生成的 HTML 作为 `agentLoop` 证据归档。原始 trace 与脱敏 viewer 应使用不同
artifact，并根据敏感等级分别控制分享范围。
