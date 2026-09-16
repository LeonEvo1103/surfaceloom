# SurfaceLoom Windows Host

这是一个独立于具体产品的 Windows 原生桌面自动化后端骨架。它通过标准输入/输出上的 NDJSON 协议接收命令，使用 Windows UI Automation（UIA）定位和操作控件。业务测试只依赖语义协议；WPF、WinForms、Win32、WinUI 或 Electron 客户端只要暴露了可用的 UIA 树，就可以通过产品 adapter 提供定位器。

## 当前边界

- 已实现：协议握手、只读环境诊断、能力查询、显式路径启动并拥有进程、按 PID 附着已有进程、当前桌面根 surface、稳定属性单个/全部定位、可读控件状态快照，以及 `invoke`、`setValue`、`toggle`、`select`、`expand`、`collapse`、`focus` 等 UIA 语义动作。
- owned session 支持 `session.close`（`WM_CLOSE`，有条件）和 `session.terminate`（进程树）；external/system session 只允许 `session.release`，host 不会结束它没有启动的进程。
- 暂未实现：鼠标或键盘注入、图像识别、多 session 并发执行、Windows 通知中心和系统文件选择器的专用组件。
- 只连接当前登录用户的默认交互桌面。测试进程与目标进程需要处于同一个用户 session。
- 自动化高权限进程时，host 通常需要同等完整性级别；这是运行条件，不是绕过安全边界的能力。
- **不支持 UAC Secure Desktop。** host 不会关闭 `PromptOnSecureDesktop`、不会尝试切换到安全桌面，也不会伪造“已处理授权弹窗”。遇到该需求会返回 `capability_unsupported`。需要验证 UAC 流程时，应由人工或隔离的系统级测试环境验证安全桌面部分。

## 运行要求

- Windows 10 2004（build 19041）或更高版本
- .NET 8 SDK
- 可交互的桌面 session；不要从 Windows Service / Session 0 执行 UI 测试

```powershell
dotnet build .\SurfaceLoom.WindowsHost.sln -c Release
dotnet run --project .\tests\SurfaceLoom.WindowsHost.ContractTests -c Release
dotnet run --project .\src\SurfaceLoom.WindowsHost -c Release
```

contract tests 是无第三方测试框架依赖的可执行程序，失败时返回非零退出码，适合先验证协议和安全能力声明。

## NDJSON 协议

每行一个请求，每行一个响应。当前协议版本为 `0.2`。

```json
{"protocolVersion":"0.2","id":"1","method":"host.handshake","params":{}}
{"protocolVersion":"0.2","id":"2","method":"host.doctor","params":{}}
{"protocolVersion":"0.2","id":"3","method":"capabilities.get","params":{}}
{"protocolVersion":"0.2","id":"4","method":"session.launch","params":{"executablePath":"C:\\path\\YourApp.exe","arguments":["--test-profile"],"workingDirectory":"C:\\path","environment":{"APP_TEST_MODE":"1"},"waitForWindow":true,"window":{"automationIds":["MainWindow"],"controlTypes":["window"]},"wait":{"timeoutMs":10000,"pollIntervalMs":100}}}
{"protocolVersion":"0.2","id":"5","method":"element.find","params":{"sessionId":"SESSION_ID","locator":{"automationIds":["num7Button"],"controlTypes":["button"]}}}
{"protocolVersion":"0.2","id":"6","method":"element.find","params":{"sessionId":"SESSION_ID","rootElementId":"DIALOG_ELEMENT_ID","locator":{"automationIds":["1"],"controlTypes":["button"]}}}
{"protocolVersion":"0.2","id":"7","method":"element.findAll","params":{"sessionId":"SESSION_ID","locator":{"controlTypes":["button"]},"wait":{"timeoutMs":1000,"pollIntervalMs":100}}}
{"protocolVersion":"0.2","id":"8","method":"element.queryBatch","params":{"sessionId":"SESSION_ID","rootElementId":"OPTIONAL_ROOT_ID","clauses":[{"names":["Settings"],"controlTypes":["window","pane"]},{"names":["Approval mode"],"controlTypes":["menuItem"]}]}}
{"protocolVersion":"0.2","id":"9","method":"element.action","params":{"sessionId":"SESSION_ID","elementId":"ELEMENT_ID","action":"invoke","expectedTarget":{"locator":{"automationIds":["num7Button"],"controlTypes":["button"],"scope":"descendants"},"processId":1234,"rootElementId":"ROOT_ELEMENT_ID"}}}
{"protocolVersion":"0.2","id":"10","method":"session.close","params":{"sessionId":"SESSION_ID","wait":{"timeoutMs":10000,"pollIntervalMs":100}}}
```

响应固定包含同一个 `id`。成功响应含 `ok: true` 与 `result`；失败响应含 `ok: false` 与结构化的 `error.code`、`error.message` 和可选 `error.details`。host 只把 JSON 写到 stdout，诊断信息写到 stderr，方便上层 TypeScript/Swift/.NET runner 稳定解析。

## `host.doctor` 只读诊断

`host.doctor` 不启动、附着、关闭或操作任何应用，也不切换桌面。它只读取当前 host 环境并返回结构化检查：

- Windows 版本和进程/系统架构；
- 是否位于非 Session 0 的登录用户 session；
- 默认 input desktop 是否处于活动且可读状态；
- UIA desktop root 是否可读取；
- 尚未针对具体目标验证的 integrity/UIAccess 边界；
- pointer/keyboard injection 未实现；
- UAC Secure Desktop 永远不尝试切换、绕过或自动确认。

每项检查的 `status` 是 `pass`、`warn`、`fail` 或 `unsupported`，并用 `required` 标明是否阻断普通 UIA session。required 的 `fail/unsupported` 会阻断；可选的 `unsupported` 只是有意保留的能力边界，不等于环境损坏。

```json
{"protocolVersion":"0.2","id":"doctor","ok":true,"result":{"schemaVersion":"1","protocolVersion":"0.2","platform":"windows","readOnly":true,"generatedAt":"2026-08-18T00:00:00+00:00","overall":"warn","checks":[{"id":"windows.os","status":"pass","summary":"Windows version meets the host minimum.","required":true},{"id":"windows.integrityBoundary","status":"warn","summary":"Doctor does not probe a target process; UIA access remains subject to Windows integrity and UIAccess boundaries.","required":false},{"id":"windows.uac.secureDesktop","status":"unsupported","summary":"UAC Secure Desktop is a security boundary and is not automated, switched to, bypassed, or auto-approved.","required":false}]}}
```

即使发现环境 `fail`，RPC 本身仍返回 `ok: true`；调用方应读取 `result.overall` 和各项 check。只有协议或 host 内部错误才使用 RPC 的 `ok: false`。

## 生命周期与 ownership

- `session.launch`：只接受绝对 exe 路径，不通过 shell 展开参数；默认等待唯一主窗口。启动前若发现同进程名实例，会返回 `target_already_running`，而不是接管已有客户端。单实例应用若新进程自行退出，也会返回 `process_exited_before_window`，不会转而连接旧实例。
- `waitForWindow: false`：立即返回 process surface；之后的 `element.find` 自动附加 PID 条件，不会扫到其他应用。
- `session.attach`：必须给出 PID，返回 `external` ownership。若窗口定位匹配多个结果且没有 `matchIndex`，返回 `window_ambiguous`。
- `session.desktop`：返回当前默认交互桌面的 `system` surface，供文件弹窗、任务栏、托盘等系统组件定位。它不代表 Secure Desktop。
- `session.release`：只释放 UIA handle。owned 进程仍运行时会拒绝 release，防止遗留测试进程。
- `session.close`：仅用于 owned session，通过 `Process.CloseMainWindow` 请求 `WM_CLOSE`；托盘或多窗口应用可能不退出，此时返回明确错误，由产品组件执行语义化 Quit 或调用 `session.terminate`。
- `session.terminate`：仅用于 owned session，终止其进程树。external/system session 调用 close/terminate 会返回 `ownership_required`。

host 收到 EOF 或自身退出时，会 best-effort 清理自己启动且仍存活的进程；它从不终止显式 attach 的外部进程。

## 定位与动作约定

定位器中的数组字段表达“同组 OR、组间 AND”：

- `automationIds`：优先使用，通常最稳定；
- `names`：可放入本地化文案或版本兼容名称；
- `controlTypes`：使用 `button`、`edit`、`menuItem`、`window` 等跨语言名称；
- `classNames`、`frameworkIds`：只在产品 adapter 中作为补充；
- `nativeWindowHandle`：面向系统窗口或诊断场景；
- `scope`：`element`、`children`、`descendants` 或 `subtree`；
- `matchIndex`：低层协议为“顺序本身就是产品契约”的有序集合保留；普通控件、动作目标和安全
  client 禁止用它消除歧义。多个候选必须继续缩小语义或 scope，不能凭 UIA tree 顺序猜测。

host 不使用屏幕坐标。动作映射到 UIA Pattern；若控件没有所需 Pattern，则返回 `action_not_supported`，而不是静默退化成坐标点击。

`element.find` 保持严格单元素语义；未指定 `matchIndex` 而出现多个结果时返回
`element_ambiguous`。`element.findAll` 使用完全相同的 selector、scope 与进程约束，但返回全部匹配，
不会因多个结果失败；等待超时仍无匹配时成功返回空数组。因为它的语义就是“全部”，请求不得携带
`matchIndex`。

`element.queryBatch` 是即时、只读的多 locator 观察：同一请求在一个 session 与一个可选
`rootElementId` 下提交 `clauses`，每个 clause 都是完整 `UiaLocator`，数组字段仍为组内 OR、组间 AND，
并保留各自的 `scope`；不得携带 `matchIndex`。host 把完整 clause 条件以 OR 连接后只执行一次
`Subtree` provider 查询，每个唯一候选只创建一次完整 `ElementSnapshot`，再用该快照分别归类，避免把
多个 locator 展平成一个更宽的 selector，也避免调用方逐次扫描 UIA 树得到相互撕裂的观察。仅当某个
`children` clause 的 selector 命中候选时，host 会额外读取该候选的 raw parent 来恢复原 scope，不会
再次全树扫描。

响应按输入顺序返回
`{"clauses":[{"clauseIndex":0,"elements":[...]},{"clauseIndex":1,"elements":[]}]}`；同一
元素可以以同一个 `elementId` 出现在多个 clause 中。每个请求最多 32 个 clauses、512 个唯一候选、
1024 个 clause-element 返回关系。任何 UIA 查询、快照、RuntimeId、scope 分类或限额错误都会让整批
请求失败，绝不截断成可能被误判为“没有遮挡”的成功结果。该方法不含 wait：连续稳定观察仍由安全
client 重复调用并应用自己的 deadline/absence policy。

`element.find` 和 `element.findAll` 都可携带可选的 `rootElementId`，把 locator 的 `scope` 限定到同一
session 已返回并记住的元素；省略时保持从 session root 查找的旧行为。未知或来自另一个 session
的 handle 返回 `element_handle_unknown`，已释放的 session 返回 `session_not_found`；两者都绝不会
静默回退到整个桌面。host 按 UIA RuntimeId
复用同一元素的 handle 并刷新其引用；每个 session 最多记住 4096 个不同元素，达到上限时返回
`element_handle_limit`，不清空或驱逐已有 handle。provider 无法给出 RuntimeId 时返回
`element_identity_unavailable`，不创建无界 fallback handle。

每个元素快照除身份、可见性和支持动作外，还返回 `value`、`hasKeyboardFocus`、`isSelected`、
`toggleState`、`expandCollapseState`、`ariaRole`、`ariaProperties` 与 `isReadOnly`。其中依赖 UIA
Pattern 或可选属性的字段在 provider 不支持时明确为 `null`；toggle 状态使用 `off`、`on`、
`indeterminate`，展开状态使用 `collapsed`、`expanded`、`partiallyExpanded`、`leafNode`。UIA provider
在查询或读取快照时抛出的失效、完整性边界拒绝、COM 或无效操作错误会转换为结构化 host error，
不会退化成成功或未分类 stderr 异常。

## Raw host 协议与安全 client

`element.find`、`element.findAll`、`element.get` 和 `element.action` 是底层 UIA 原语，不是可以直接在
产品 scenario 中使用的完整安全工作流。动作原语自身会核对 `expectedTarget`，但 host 不理解
“设置已打开”“菜单已关闭”等产品 postcondition，也不会替调用方选择正确候选或恢复 UI 基线。
`SessionResult.Root` 同样是创建 session 时的时点快照；读取当前可见性、状态或 Pattern 前应通过
`element.get` 刷新，不能长期把初始快照当作当前事实。

产品 adapter 的默认安全 client 路径必须遵守以下合同：

1. 先用 `element.findAll` 取得严格 locator 的全部候选，再按 visible、enabled、所需 UIA action、
   `ariaRole`、`isReadOnly` 等语义筛选；不得先取第一个再补检查。
2. 动作目标必须只有一个 eligible candidate，并且同一 `elementId` 连续通过至少两次观察。零候选、
   多候选、身份变化或瞬时 UIA 查询失败都会重置稳定性；超时后 fail closed。
3. 普通动作目标禁止 `matchIndex`。先缩小到 window/dialog/component 的 `rootElementId`，再改进稳定
   AutomationId、role、name 或 Pattern 约束。只有顺序本身属于明确验收契约的集合读取才可用 index。
4. `element.action` 必须携带原 root、完整 locator 和所选 PID；host 在同一次 dispatch 中重新核对
   root/目标 RuntimeId、scope、selector、可见性、启用状态与所需 Pattern 后立即提交。每个业务动作
   最多提交一次。provider 可能已经完成动作，随后在返回快照时才报告 stale/COM 等错误，因此任何
   action error 都不能作为自动重试依据；调用方必须观察独立 postcondition。
5. postcondition 可以轮询，但不能重放动作。若成功则接受动作响应的不确定性；若失败则同时保留动作
   和观察错误。取消信号必须继续可识别，不能包装成普通 assertion failure。
6. “消失”必须是同一语义筛选下连续多次成功观察到零候选；单次 missing、短暂 offscreen 或查询异常
   都不能证明关闭完成。
7. 改变菜单、dialog 或 surface 的流程必须登记 cleanup，并在返回前重新证明 baseline。cleanup 无法
   证明恢复时抛出 `UiStateTaintedException`；runner 必须停止剩余 live case，不能在未知状态继续操作。

`UiaElementSelectionPolicy`、`UiaStableElementSelector`、`UiaStableAbsenceSelector`、
`UiaAtMostOnceAction` 和 `UiStateRecovery` 是当前 .NET client 的可复用安全构件。产品名称、locator 和
postcondition 仍留在产品 adapter，不能反向写进这些通用构件。
`UiaAtMostOnceAction.SubmitObserved` 会在唯一一次 native submission 前调用
`IUiaActionSubmissionObserver.RecordSubmissionEntered`，其失败会阻止动作；动作返回或变成 indeterminate
后、返回调用方前再记录 result。需要跨崩溃防重放的产品 observer 必须把 entered 实现为 durable 且独占的
消费标记；合同覆盖同一 observer 的顺序与并发重放，并要求实际 submission 总数始终为一。
`AriaRoles` 默认严格要求 provider 提供并匹配角色；只有当 Name、ControlType 与 owner scope 已独立形成
精确语义证据、且目标 provider 确认会遗漏可选 UIA ARIA 属性时，产品 policy 才可显式开启
`AllowMissingAriaRole`。该开关只接受 `null`（property unsupported），不会接受空字符串、错误角色、
offscreen 候选、歧义或 identity churn。

Raw `ElementSnapshot` 可能包含输入值或 ARIA properties，禁止整对象写日志或错误消息。失败诊断只能
通过有候选数与总长度硬上限的 `UiaSafeDiagnosticFormatter` 输出：允许显式声明为安全的静态 locator
值和 control type/visible/enabled 等结构信息，其余 name、AutomationId、className 必须脱敏；永不输出
`value`、`ariaProperties`、PID/HWND、路径、RuntimeId、用户会话或输入内容。postcondition 和 cleanup
异常也必须使用非敏感 operation key 与安全诊断，不能直接拼接任意 UI 文本。

## 渐进扩展建议

1. 上层先实现通用 `DesktopDriver` client，把协议调用隐藏起来。
2. 在产品 adapter 中维护名称、AutomationId 与版本兼容策略，不写进 scenario。
3. 为 Open/Save Dialog、任务栏、托盘、通知等系统边界新增专用 component，并通过 capability 声明可用性。
4. 如需真实快捷键或拖拽，单独增加受控 input backend；不要改变现有 UIA 语义动作的行为。
5. CI 使用带登录用户的隔离 Windows VM，并在每次用例后销毁或还原快照。
