# SurfaceLoom 文档导航

这份导航按第一次接触项目时最常见的四个阶段组织。README 负责快速判断项目是否适合你；
详细设计、能力状态和贡献规则以各自的权威文档为准。

## 1. 了解项目

1. [项目首页](../README.md)：先看 SurfaceLoom 解决什么 Agent 行为验证问题、典型场景、当前限制
   和最短可运行示例。
2. [能力事实矩阵](framework/capabilities.md)：查看每项能力属于 `declared`、
   `contract-tested`、`live-fixture-tested` 还是 `target-app-tested`，以及相应证据和限制。
3. [Framework SSOT](FRAMEWORK_SSOT.md)：了解产品边界、执行语义、里程碑和唯一任务账本。它是
   路线与完成状态的唯一事实源，不是入门教程。
4. [V2 架构](ARCHITECTURE_V2.md)：理解场景、产品适配器、语义组件、驱动契约和平台 backend 的
   依赖方向。
5. [开源框架借鉴与吸收边界](OPEN_SOURCE_INSPIRATION.md)：了解 SurfaceLoom 从 Playwright、
   Appium、Robot Framework 等项目借鉴了什么，以及明确没有照搬什么。

## 2. 跑通示例

1. [入门指南](GETTING_STARTED.md)：从源码克隆、构建九个私有包、运行 reference-agent showcase，
   并正确理解 `2 passed / 2 failed`、exit `1` 和 exit `2`。
2. [Reference Agent 示例](../examples/reference-agent/README.md)：深入查看 approval testing、工具调用
   账本、side-effect probe、四 Case M1 showcase 和八 Case 故障矩阵。
3. [Playwright 浏览器后端](PLAYWRIGHT.md)：安装浏览器、使用语义 DOM locator、运行显式 live smoke，
   并理解浏览器进程和敏感制品边界。
4. [测试报告与 AI 验收](REPORTING.md)：阅读 `report.json`、HTML、AI-review Markdown、证据保留和
   Reporter v2/v3 的权威边界。
5. [Agent loop 轨迹与可视化](AGENT_LOOPS.md)：导入、脱敏、合并并展示 Agent、工具、浏览器和桌面
   事件；timeline 用于诊断，不产生 verdict。实际 CLI 命令见
   [package guide](../packages/agent-loop/README.md)。

需要平台验证时，分别参考 [macOS fixture](../native/macos-fixture/README.md)、
[Windows host](../native/windows-host/README.md) 和
[Windows fixture](../native/windows-fixture/README.md)。这些路径的证据等级不同，不能相互替代。

## 3. 理解设计

- [Case 编写规范](CASE_SPEC.md)：稳定 CaseSpec、运行结果、平台字段、验收条件和证据之间的边界。
- [组件目录](COMPONENT_CATALOG_V2.md)：组件语义、manifest、fixture、优先级和防膨胀规则；这是目标目录，
  不代表全部行为已实现。
- [组件库入口](COMPONENT_LIBRARY.md)：当前 macOS 与 browser 组件积木，以及产品 adapter 的责任边界。
- [通用运行辅助模块](RUNTIME_HELPERS.md)：减少浏览器配置、等待和诊断采集中的重复代码。
- [添加测试指南](ADDING_TESTS.md)：从 CaseSpec 到 locator、fixture、副作用门禁、报告和验证的完整流程。
- [Playwright 浏览器后端](PLAYWRIGHT.md)：DOM surface 与 AX/UIA/System Surface 的职责分工。
- [Windows 自动化后端设计](WINDOWS.md)：UIA/Win32 host、定位器、进程 ownership、系统表面和 CI 条件。
- [测试报告与 AI 验收](REPORTING.md)：为什么报告消费执行事实，而不负责执行或重新判断产品。
- [Agent loop 轨迹与可视化](AGENT_LOOPS.md)：trace adapter、显式关联和静态 viewer 的非权威边界。
- [Release contract](release/README.md)：候选制品、清单、扫描和发布就绪门槛；当前不执行 registry 发布。
- [Native protocol package](../packages/native/README.md)：`surfaceloom.native/1.0`、Node transport、
  ownership、deadline、cancellation 和 operation receipt。
- [Product adapter boundary](../projects/README.md)：产品 locator、启动策略、fixture 和 scenario 应放在哪里。

设计文档描述目标形态时，最终仍以 [Framework SSOT](FRAMEWORK_SSOT.md) 的任务状态和
[能力事实矩阵](framework/capabilities.md) 的实证等级为准。

## 4. 参与贡献

1. [贡献指南](../CONTRIBUTING.md)：先确认改动层级、共享组件门禁、本地验证、公开前审计和 PR 检查项。
2. [添加测试指南](ADDING_TESTS.md)：涉及 Case、产品 adapter、组件或 backend 时按这里的顺序施工。
3. [Case 编写规范](CASE_SPEC.md)：新增或修改可执行场景时必须同步维护 CaseSpec。
4. [安全策略](../SECURITY.md)：处理权限、真实服务、凭据、截图、trace、录屏和附件前必须阅读。
5. [Framework SSOT](FRAMEWORK_SSOT.md)：修改执行语义或任务状态前，先引用稳定任务 ID，避免创建
   冲突路线。

首次 PR 建议从文档、合同测试或已有 issue 的窄范围修正开始。不要把尚未执行的 smoke、默认 skip、
manifest 声明或设计目标写成已经验证的能力。
