# 开发 Agent 添加配套自动化测试

## 先写 CaseSpec，再写执行代码

每条 Case 必须先进入独立 `CaseSpec`：稳定 ID、`locale`、至少一个正式 `platforms`、中文 Suite/Case 名、可选源测试名、
原始语义、显式前置条件、带稳定 ID 的验收条件、最高副作用和标签。`locale: "zh-CN"` 时中文
字段会被 Core 强校验；只写英文 `@Test` 名或 runner 命令名不算完成 Case 定义。

运行状态、耗时、步骤、错误和证据属于本次 `result`，不得写回 CaseSpec。步骤使用
`criterionIds` 关联验收条件；`skipped`/`unsupported` 必须说明原因。完整字段、示例和原生
行为边界见 [Case 编写规范](CASE_SPEC.md)。

产品 sidecar 使用 `projects/<product>/cases/<domain>/<case-id>.case-spec.json`，一条
Case 一个文件。`platforms` 只能列出已经存在执行实现的 `macos`/`windows`/`web`，不能用普通 tag 冒充。
Swift Testing 的 `@Test` display name 与 Windows C# 的产品 case attribute 位置字符串
保留为精确 `sourceName`，中文 `name` 与 `intent` 放在 sidecar；不要通过直接翻译源测试名破坏映射。
Core 和 Reporter 目前只提供 Web Case 合同，尚无通用 browser source mapper。产品声明 `web` 前
必须同时实现 browser runner、source 映射和门禁；不得仅因类型接受 `web` 就宣称已有执行覆盖，
也不应伪装成 macOS 或 Windows 原生测试。

## 先判断改动属于哪一层

| 变化 | 修改位置 |
|---|---|
| 文案、test id、AX role、UIA control type | `projects/<product>` schema |
| 产品独有的 profile、就绪条件、菜单策略 | `projects/<product>` adapter |
| 已有组件的新产品验收行为 | `projects/<product>` scenarios |
| 跨产品可复用的桌面或 Agent 行为 | 组件实现 + component manifest |
| AX/UIA/窗口/进程的新原语 | 对应 platform backend + driver contract |
| 网页 DOM、导航、网页内表单或断言 | 产品 adapter + `packages/browser-playwright` |

测试场景只描述用户意图和可观察结果，不应知道控件是 `AXButton` 还是
`ControlType.Button`，也不应知道虚拟键码或坐标。

## 组件复用与新增判定

按下面顺序判断，不要从修改共享组件开始：

1. 现有组件能否通过组合表达需求？能则直接复用。
2. 差异是否只是产品文案、test id、等待策略、fallback 或独有流程？是则只改产品 adapter、
   schema 或 scenario。
3. 是否在修正或补全现有组件的同一语义？是则可以修改，但要保持职责、兼容已有消费者，
   并补 contract test。
4. 是否出现了独立、清晰、可跨产品复用的新语义边界？是则可以新增组件；先检索 manifest，
   避免重复或高度重叠的组件。
5. 当前是否只有一个产品需要，或复用边界仍不确定？先放在 `projects/<product>`，有复用证据后
   再提升到共享目录。

任何共享组件变更都要保持架构卫生：单一职责、依赖方向不反转、无产品名/文案/路径、无未声明
副作用，并同步维护 manifest、platform、capability、locator key、fixture、测试与文档。不得静默
修改 component id/action；提交说明需要记录选择修改或新增的理由、影响范围和兼容策略。

## 标准工作流

1. 先判断目标属于原生窗口/System Surface，还是网页 DOM；跨边界流程明确写出切换点。
2. 从 `packages/component-catalog` 按 domain、platform、capability 查询已有组件。
3. 检查产品 adapter 是否声明了所需 capability 与 locator。
4. 复用组件写 scenario；无法支持时应得到明确的 `unsupported`。
5. 为 locator 变化改 schema，为行为变化改 scenario。
6. 新增组件时同步 manifest、side-effect 等级和 contract test。
7. 根据副作用等级选择 fixture、隔离 profile、专用用户或 VM。

框架 fixture 是按需创建的依赖图：测试未引用的 fixture 不启动；test scope 在每条用例后
清理，worker scope 在整组测试后清理，teardown 始终按 setup 的逆序执行。组件 manifest 的
`requiredFixtures` 是开发 Agent 和 runner 共用的机器可读依赖，不能只写在测试注释里。
产品 adapter 必须把这些 id 注册为可执行 `FixtureDefinition`；`FixtureRegistry` 在启动前
校验全部引用，缺少 setup 时直接失败，不能临时回退到真实模型、真实工具或用户文件。

组件中的元素动作统一走 `session.actions`，不直接持有原生 backend。Core 会先执行该动作
默认与额外声明的 actionability 检查；后端无法落实任何一个必需检查时必须失败。定位与
检查可在 `timeoutMs` 内轮询，但点击、输入、审批等原生副作用只提交一次，失败后不自动重放。

## Locator 原则

推荐产品为重要控件暴露稳定测试 ID，并映射到：

- macOS：`AXIdentifier`
- Windows：`AutomationId`

定位顺序是 test ID → 语义 role + 本地化名称 → 产品 adapter 中的受控平台 fallback。
场景中禁止 XPath、AX/UIA 常量、屏幕坐标和面向具体文案的查询。

Locator 默认采用 strict match：匹配 0 个是 missing，匹配多个是 ambiguous。确有重复元素时，
先缩小 window/dialog/component scope；只有列表顺序本身就是产品契约时，才能显式使用 index，
且该选择会进入诊断。禁止用隐式 `firstMatch` 让歧义测试碰巧通过。

Windows 的 `element.find` / `findAll` / `queryBatch` / `get` / `action` 是 raw host API。产品 scenario 不得把一次 raw
查询或 raw action 当成完整用户步骤；adapter 应提供默认安全 client 封装：

- 对全部候选先按 visible、enabled、精确所需 Pattern、ARIA role/read-only 状态筛选，再要求唯一；
- 唯一候选必须以同一 element identity 连续稳定，期间出现 0 个、多个、身份切换或查询异常都重置；
- 动作目标禁止用 `matchIndex` 猜测；先缩小到 dialog/component root。仅有序集合本身是验收契约时
  才允许 index，而且不得把该例外扩散到普通按钮、菜单项或输入框；
- invoke、setValue、select、toggle 等副作用动作最多提交一次，随后轮询独立 postcondition。动作响应
  失败也可能发生在动作已经生效之后，禁止根据异常自动重放；
- 元素消失必须连续多次成功观察为零候选，单次 missing/offscreen 或 UIA 错误不算完成；
- 同一安全判断涉及多个异构 locator 时使用 `queryBatch` 保留每个 clause 的完整 AND 约束；禁止分别
  合并 names、controlTypes 或 frameworkIds，因为这会产生原 locator 从未允许的笛卡尔积误匹配；
- 一次稳定观察应来自一次批量树采样；连续稳定性由 client 重复完整批次证明，任一批次失败或超期都
  不得当作“全部缺席”；
- session 创建时的 root 是时点快照；断言当前 root 状态前先刷新，不能复用陈旧字段；
- cancellation 必须保持可识别；它仍应触发必要 cleanup，但不能被包装成普通失败后继续运行。

凡是会打开菜单、dialog、picker 或切换 surface 的 component，都要在动作尝试前登记恢复责任，成功
退出前重新证明 baseline。cleanup 失败时应抛出共享的 UI-state-tainted 错误；共享 harness 必须在进入
后续 case body 前熔断，绝不能在未知 UI 状态继续执行。带 suite coordinator 的 runner 应把被熔断的
后续 case 标为 `NOT_RUN`；直接使用 Swift Testing 的 macOS lane 目前会把同一“body 未执行”的熔断
呈现为失败。普通失败只有在 cleanup 已证明成功后才允许继续下一 case。

Windows raw snapshot 可能包含输入值、ARIA properties 或用户内容，禁止直接序列化到日志。诊断只可
包含有上限的候选数量、已明确安全的静态 locator 值和 control type/visible/enabled/action/role 等
结构信息；其他字段应脱敏，并禁止输出 value、路径、PID/HWND、RuntimeId、会话文本和用户输入。
错误消息、postcondition 与 cleanup 也只能使用非敏感 operation key 和经过同一规则处理的诊断。

macOS 产品 schema 示例：

```swift
let settings = MacOSAXLocator(
	"Settings button",
	identifiers: ["settings.open"],
	labels: ["Settings", "设置"],
	roles: [MacOSAXRole.button]
)
```

上面是产品 adapter 的实现细节，场景只调用 `settings.open()`。

### DOM Locator

浏览器页面使用 `@surfaceloom/browser-playwright` 的独立 `DomLocator`，不得把 CSS、DOM
节点或 Playwright 对象塞进 Core `Locator`。优先级为 role + accessible name、label、testId、
稳定文本；CSS 只允许作为产品 adapter 中显式可审查的 escape hatch。

```ts
const submit = defineDomLocator({
  key: "checkout.submit",
  kind: "role",
  role: "button",
  name: "提交订单",
});

await browser.click(submit);
```

点击、填写和读取会先证明目标恰好匹配一个元素。DOM 等待可以由 Playwright 重试，但产生副作用
的业务步骤仍不得由场景层自动重放。地址栏、浏览器菜单、系统权限和文件面板不是 DOM，继续走
SurfaceLoom AX/UIA 与 System Surface 组件。完整接入方式见 [Playwright 浏览器后端](PLAYWRIGHT.md)。

## Agent 场景需要确定性 fixture

不要让每次回归依赖真实 LLM。`AgentFixtureController` 应能脚本化：

- streaming chunks 与完成时机；
- tool pending/running/success/failure；
- approval、deny、retry 和断线重连；
- Computer Use session 状态；
- side-effect probe 记录工具实际执行次数。

发布候选再运行少量真实模型 smoke。审批前工具不得执行、deny 后零副作用、Emergency Stop
后输入事件不再增长，都需要 probe 断言，而不是只看 UI 文案。

## 副作用门禁

| 等级 | 例子 | 默认策略 |
|---|---|---|
| `readOnly` | 查看窗口、读取状态 | CI 可运行 |
| `reversible` | 打开后取消文件面板 | 隔离 profile |
| `writesLocal` | 修改 fixture 文件 | 临时 workspace |
| `externalEffect` | 发消息、调用外部服务 | 显式门禁 + fake 优先 |
| `securitySensitive` | 权限、UAC、Computer Use 控制 | 专用用户/可恢复 VM |

## 报告与证据

场景需要引用完整 CaseSpec，并产生可关联验收项的语义步骤。runner 把结果与 screenshot、video、trace、
Accessibility tree 等附件交给 `packages/reporter`，不要在 Component 中生成 HTML。Playwright
返回的 screenshot/trace 已标为 sensitive；runner 补齐稳定 id、phase 和 captureStatus 后，再作为
`SourceArtifact` 交给同一证据保留策略。

- `report.json` 是事实源；`ai-review.md` 和 `index.html` 由它生成。
- skipped、unsupported、captureFailed 必须单独记录，不能折算成 passed。
- 默认失败保留截图/视频，成功只留轻量 trace；attach/existing-profile runner 必须显式关闭媒体。
- 视频应配关键帧和语义时间线，便于 AI 先做低成本验收。
- 证据路径必须相对报告目录，敏感附件不能自动上传或在报告中展开。

完整说明见[测试报告与 AI 验收](REPORTING.md)。

## 验证

```bash
./scripts/check-architecture.sh
./scripts/run-typescript-tests.sh
./scripts/run-swift-tests.sh
```

Windows 改动还需运行对应 .NET 子工程测试。产品 live 场景由
`projects/<product>/scripts` 下的 runner 显式启用，不能把 live 开关设成默认值。

产品若要进入仓库级报告，应在 `projects/<product>/repository-checks.mjs` 导出
`defineProductRepositoryChecks`，并把产品环境变量前缀一并登记用于子进程环境清理。共享报告 runner
只按稳定顺序发现这些产品 provider，不得导入、命名或硬编码某个产品。CaseSpec 与产品源码的双向
映射合同也放在 `projects/<product>/contracts`，由通用仓库合同入口自动发现。
