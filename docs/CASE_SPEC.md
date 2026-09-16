# Case 编写规范

每条自动化用例先定义稳定的 `CaseSpec`，runner 再单独记录本次 `result`。两者不能平铺混写，
也不能让一次失败、跳过或证据缺失反向改写用例原意。

```text
CaseSpec（长期契约）             result（单次执行事实）
├── 稳定 ID                     ├── 状态与未执行原因
├── 中文 Suite 与 Case 名       ├── 开始时间与耗时
├── 可执行平台                  ├── 语义步骤
├── 源测试名（可选）            ├── 错误
├── 原始语义                    └── 截图、录屏、日志等证据
├── 前置条件与验收条件
└── 副作用与标签
```

## 必填字段

| 字段 | 约定 |
|---|---|
| `id` | 稳定 ASCII 机器 ID，不从标题生成，不含路径、用户内容或凭据 |
| `locale` | 规范文本语言；本仓库内置用例使用 `zh-CN` |
| `platforms` | 至少一个、不可重复；只能填写 `macos`、`windows`、`web`，表示已有对应平台执行实现 |
| `suite.id` | 稳定的功能域 ID |
| `suite.name` | 功能域中文名 |
| `name` | 中文 Case 主名称，描述用户可感知行为 |
| `sourceName` | 可选；保留上游 XCTest/Swift Testing/TRX 的原始名称，不能替代中文名 |
| `intent` | 原始业务语义：为何要测、保护什么风险，不写本次运行结果 |
| `preconditions` | 必须显式存在；无前置时写 `[]`，每项有稳定 `id` 和中文 `text` |
| `acceptanceCriteria` | 至少一项；必须是可观察、可判定的结果，每项有稳定 ID |
| `sideEffect` | 整条 Case 允许的最高副作用等级 |
| `tags` | 可选分类，不承担前置条件或验收语义 |

Core 的 `defineCaseSpec()` 会验证并深度冻结上述字段，包括 `platforms` 数组。`locale` 为 `zh-CN` 时，Suite 名、Case
名、原始语义、前置条件和验收条件必须包含中文；这样开发 Agent 不能只交一个英文测试函数名。
框架本身仍支持 `en-US` 等其他语言，不把通用能力绑定到单一产品或语言。

## 产品 Case 目录与映射

产品原生测试使用一条 Case 一个 sidecar：

```text
projects/<product>/cases/<domain>/<case-id>.case-spec.json
```

JSON 只包含 `CaseSpec`，不包含运行结果。文件名便于查找，机器身份仍以文件内的
`id` 为准。`platforms` 是可执行能力契约，不是普通分类 tag：只有已有该平台 source case 时才能
列入。macOS Swift Testing 的 `@Test` display name 与 Windows C# 的产品 case attribute
位置字符串都必须精确等于 `sourceName`；中文 `name` 只是报告与人工
阅读的主名，不要为了翻译而破坏上游结果映射。

例如，一个同时包含两个平台实现的产品可以用下列命令检查双向映射：

```bash
npm --prefix packages/core ci
npm --prefix packages/core run build
node scripts/validate-case-specs.mjs \
  --spec-dir projects/sample-app/cases \
  --swift-dir projects/sample-app/Tests/SampleAppAdapterTests \
  --csharp-dir projects/sample-app/windows \
  --csharp-case-attribute SampleAppWindowsCase
```

`--csharp-case-attribute` 由产品适配器显式提供，通用扫描器不内置任何产品属性名。检查会拒绝
非法 CaseSpec、重复 `id`、同一平台重复 `sourceName`、没有对应 sidecar 的 Swift/C#
测试，以及声明适用原生平台却没有对应 source case 的孤立 sidecar。只声明 `macos` 的 spec 不要求 C#，
只声明 `windows` 的 spec 也不要求 Swift。Core 和 Reporter 当前只建立 `web` 平台合同；仓库尚未
提供通用 browser source mapper，因此现有校验器不会证明 web 实现存在。产品在声明 `web` 前必须
自行提供 browser runner、source 映射和对应门禁，且不能冒充 Swift/C# 原生映射。通用 CLI 也允许只传 `--swift-dir`，或只传成对的
`--csharp-dir` 与 `--csharp-case-attribute`，便于单平台产品复用。`./scripts/run-typescript-tests.sh`
会在 Core 建置完成后自动运行这项检查。

Windows 扫描根必须覆盖该测试 assembly 的完整源码发现域，不能只指向惯例上的 `Tests/` 子目录。
case attribute 必须独立声明；attribute group、target specifier 和指向 case attribute 的 `using` alias
会失败关闭。扫描器支持合法的 `Attribute` 后缀、限定名和 C# Unicode identifier，并拒绝源码树中的
symbolic link，避免编译域大于静态映射域。

## 完整示例

```ts
import { defineCaseSpec } from "@surfaceloom/core";

export const closeWindowCase = defineCaseSpec({
  id: "desktop.lifecycle.command-w-hide-and-reopen",
  locale: "zh-CN",
  platforms: ["macos"],
  suite: { id: "app.lifecycle", name: "应用生命周期" },
  name: "Cmd+W 隐藏窗口且重新打开后恢复",
  sourceName: "Cmd+W hides and a Dock-equivalent reopen restores",
  intent: "验证关闭主窗口不会误退出应用，并且用户仍能重新显示唯一主窗口。",
  preconditions: [
    { id: "owned-instance", text: "测试已启动并拥有一个隔离应用实例。" },
    { id: "main-window-visible", text: "唯一主窗口位于屏幕内且可见。" },
  ],
  acceptanceCriteria: [
    { id: "window-hidden", text: "执行 Cmd+W 后主窗口变为不可见。" },
    { id: "process-alive", text: "隐藏窗口后应用进程仍然存活。" },
    { id: "window-restored", text: "重新激活应用后恰有一个可见主窗口。" },
  ],
  sideEffect: "reversible",
  tags: ["macos", "release-candidate"],
});
```

`name` 是给人和报告看的中文行为名；`sourceName` 用来对齐上游 runner；`intent` 才是 Case 的
原始语义。三者职责不同，不能用“命令退出码为 0”同时冒充名称和业务意图。

## 执行结果规范

Reporter v2 接收 `{ spec, result }`。步骤的 `criterionIds` 应关联它实际检查的验收项，AI 和人
无需根据步骤文案猜测覆盖关系。

```ts
{
  spec: closeWindowCase,
  result: {
    status: "passed",
    startedAt: "2026-08-19T01:00:00.000Z",
    durationMs: 834,
    steps: [
      {
        id: "close-and-observe",
        title: "关闭窗口并观察进程",
        status: "passed",
        durationMs: 312,
        criterionIds: ["window-hidden", "process-alive"],
      },
      {
        id: "reopen-and-observe",
        title: "重新激活应用并观察主窗口",
        status: "passed",
        durationMs: 522,
        criterionIds: ["window-restored"],
      },
    ],
  },
}
```

- `failed`、`timedOut` 必须带 `error`。
- `skipped`、`unsupported` 必须带中文 `reason`，不能伪装成通过。
- `passed` 不能包含未通过步骤。
- `passed` 的通过步骤必须覆盖全部验收条件；不允许零步骤或未映射验收项的“空绿灯”。
- 步骤引用不存在的验收项 ID 会被拒绝。
- `preconditions` 描述开始前必须成立的事实，不把“权限不够”写成通过标准。

## 桌面原生 Case 的语义边界

- Cmd+W：要分别断言窗口隐藏、进程存活和重新显示；不能只断言快捷键已发送。
- Cmd+Q：只对测试拥有的实例执行，并以进程终止为主断言。
- 文件选择器：如果只做“打开并取消”，名称和原始语义不得写成“成功选择文件”。
- TCC/UAC：权限预检、用途文案静态检查和首次授权窗口流程是三个不同 Case。没有在专用用户或
  可恢复 VM 中真实执行授权流程时，不得写成“授权流程通过”。
- Emergency Stop：只检查菜单入口存在时，不得声称已经验证停止动作或输入事件归零。

Swift Testing、XCUITest、XCTest 和 Windows runner/importer 应把上游名称保存到 `sourceName`，
并用稳定映射找到同一份 `CaseSpec`。Windows 产品适配器可以用类似
`[SampleAppWindowsCase("精确 sourceName")]` 的 attribute 提供静态映射。没有逐用例 importer 时，仓库命令只能
作为“命令级 Case”上报，不能把一条退出码为 0 的命令伪装成内部所有 UI Case 都已通过。
