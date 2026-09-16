# `@surfaceloom/agent-loop`

把不同 Agent runtime、模型、工具、审批、桌面和浏览器事件归一到同一条安全时间线。

这个包包含五个稳定边界：

1. `TraceAdapter`：格式检测与导入插件；
2. `AgentLoopTrace v1`：与具体 Agent/runtime 解耦的事件 schema；
3. `mergeAgentLoopTraces`：按绝对时钟对齐多个来源，没有时钟时明确降级为相对时间；
4. `renderAgentLoopHTML`：不含 JavaScript、外部资源和原始敏感内容的单 case 静态 viewer；
5. `renderAgentLoopListHTML`：面向多个测试 case 的紧凑 suite/list viewer。

首版内置 Codex rollout JSONL 和 SurfaceLoom 原生 trace adapter。它们是通用框架的参考实现，
不要求被测 Agent 使用这些产品或格式；厂商或产品格式应放在独立 adapter package 中。

## CLI

```bash
npm --prefix packages/agent-loop run build
node packages/agent-loop/dist/cli.js \
  --input /path/to/trace.jsonl \
  --output /tmp/agent-loop.html \
  --format auto
```

重复传入 `--input` 会生成测试集总览。每个 case 包含最终状态、历史失败/阻塞计数、紧凑泳道和
可展开事件明细。大 case 在 list viewer 中使用确定性采样，并优先保留失败/阻塞事件；单 case
viewer 仍展示完整事件：

```bash
node packages/agent-loop/dist/cli.js \
  --input /path/to/case-1.json \
  --input /path/to/case-2.json \
  --output /tmp/agent-loop-cases.html \
  --format surfaceloom \
  --title "Agent regression cases"
```

也可以一键递归导入目录。默认的 `auto` 格式会逐个识别 Codex、SurfaceLoom 或已注册的
第三方格式：

```bash
node packages/agent-loop/dist/cli.js \
  --input-dir /path/to/local-traces \
  --output /tmp/agent-loop-cases.html \
  --title "Agent loop regression"
```

目录发现只选择文件名含 `trace` 或 `rollout` 的 JSON/JSONL/NDJSON/TRACE 文件，不跟随符号链接，
并跳过常见生成目录。无法识别的候选文件计入批次 warning；显式 `--input` 仍然失败即终止。
源文件路径不会写入 HTML。

默认拒绝覆盖现有输出；只有调用者显式传入 `--force` 才会覆盖。单个输入限制为 32 MiB，默认最多
保留 10,000 个事件；list viewer 最多接受 500 个 case、合计 100,000 个事件。多个输入会顺序读取，
避免同时把所有原始 trace 留在内存。prompt、message content、reasoning、工具输入输出、凭据和
用户目录在进入统一 schema 前即被省略或脱敏。

## 自定义 adapter

```ts
import { importAgentLoop } from "@surfaceloom/agent-loop";
import type { TraceAdapter } from "@surfaceloom/agent-loop/adapter-sdk";

const adapter: TraceAdapter = {
  id: "my-runtime",
  detect: (input) => input.includes('"my_trace_version"') ? 100 : 0,
  import: (input, options) => normalizeMyTrace(input, options),
};

const trace = importAgentLoop(rawTrace, { adapters: [adapter] });
```

`detect` 返回 `0..100` 的置信度。最高分并列会报错，避免自动检测悄悄选择错误格式。
adapter id 与 trace source 使用同一套命名约束：小写字母或数字开头，只允许小写字母、数字、
点、下划线、斜杠和连字符，最长 64 个字符；建议使用 `vendor/runtime` 形式避免冲突。
adapter 只能依赖 package exports，不能 deep import `src/*`。宿主会再次执行输入大小、事件上限、
标识符、脱敏和 schema 校验；自由文本 summary 和不安全 metadata 不进入共享 viewer。
