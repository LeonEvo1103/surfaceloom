# 组件库入口

机器可读的权威目录位于 `packages/component-catalog`；完整分类、职责与优先级见
[COMPONENT_CATALOG_V2.md](COMPONENT_CATALOG_V2.md)。

## 已落地的 macOS 组件积木

| 组件 | 职责 |
|---|---|
| `ApplicationLifecycleComponent` | owned process、关闭窗口、重开、正常 Quit 契约 |
| `WindowComponent` | 可见窗口数量与等待 |
| `MenuComponent` | 打开菜单、查找/调用菜单项 |
| `DialogComponent` | 出现、动作、消失 |
| `TextInputComponent` | 值、enabled、设置值 |
| `CollectionComponent` | 计数和选择语义项 |
| `NativeFileDialogComponent` | macOS 原生文件面板出现、选择既有本地目录、取消、消失；非法/非目录输入失败关闭 |
| `MacOSBundleInspector` | Info.plist purpose string contract |

这些是 Swift/macOS backend 的实现，不是跨平台 API 本身。共享语义以 `packages/core` 为准；
Windows backend 必须通过同一 contract，而不是复刻 Swift 类型名。

## 已落地的浏览器组件与后端

组件目录已登记 `desktop.common.web-view`，用于证明原生 WebView/浏览器表面已加载，并把网页
工作显式交给 browser backend。`packages/browser-playwright` 提供当前实现：owned browser
launch、独立 context、语义 DOM locator、严格唯一动作、导航、等待、截图和 trace。

它不负责浏览器地址栏、菜单、系统权限或文件面板，也不允许产品场景直接持有 Playwright 对象。
使用方法与证据接线见 [Playwright 浏览器后端](PLAYWRIGHT.md)。

## 产品适配器边界

公开仓库不内置具体产品适配器。使用方可以在 `projects/<product>` 或独立私有仓库中维护
产品 profile、退出策略、定位器、系统权限验收和业务场景。这些对象不得反向进入 Core；
只有跨产品稳定复用的语义才能提升为共享组件。

## 首批建议实现

通用 P0：Lifecycle、Window、Menu、Dialog、Navigation、TextInput、List、Settings、
OpenFile、SaveFile、NativeAlert。

Agent P0：Composer、Transcript、RunState、StreamingResponse、ToolCallCard、ApprovalGate、
AttachmentTray、EmergencyStop。

组件 manifest 可以先完整描述候选能力；真正的 class/implementation 应按垂直场景逐个实现，
不要一次生成几十个没有行为的空壳。
