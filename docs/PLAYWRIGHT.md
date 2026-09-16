# Playwright 浏览器后端

`packages/browser-playwright` 是 SurfaceLoom 的可选 DOM 自动化后端。它与原生桌面
backend 并列，而不是替换 macOS Accessibility 或 Windows UI Automation。

## 职责边界

| 表面 | 负责人 |
|---|---|
| 浏览器或客户端窗口、菜单、地址栏 | SurfaceLoom AX/UIA backend |
| 系统权限、文件面板、OAuth 返回应用 | SurfaceLoom System Surface |
| 页面 DOM、导航、表单、网页断言 | Playwright browser backend |
| 截图、trace、视频等证据保留 | runner 转换后交给 Reporter |

`packages/core` 不导入 Playwright 类型或运行时。DOM locator 只存在于 browser package，
产品 adapter 负责决定何时从原生 WebView/浏览器表面切换到 DOM session。

## 安装

每个 package 使用独立 lockfile：

```bash
npm --prefix packages/browser-playwright ci
npx --prefix packages/browser-playwright playwright-core install chromium
```

只需要系统 Chrome 时，也可以在启动选项中设置 `channel: "chrome"`，避免下载额外浏览器。

## 本地验证

本机已安装 Chrome 时，可以重复运行真实浏览器用例：

```bash
npm --prefix packages/browser-playwright run test:local
```

该命令覆盖真实页面导航、label/role/testId 定位、表单输入、严格唯一匹配以及 owned session
关闭。默认 TypeScript 测试还会同时执行 Core 的原生 `GuardedElementActions` 和 browser
session 动作，确认两条 dispatch 路径、两套 locator 以及生命周期互不串线。

这里的“原生共存”验证针对 TypeScript Core 契约；macOS Swift 与 Windows host 仍通过各自的
进程/语言边界工作，不会把 Playwright 对象传入 AX/UIA backend。

## 使用

```ts
import {
  PlaywrightBrowserBackend,
  defineDomLocator,
} from "@surfaceloom/browser-playwright";

const session = await new PlaywrightBrowserBackend().launch({
  engine: "chromium",
  headless: true,
  context: {
    baseURL: "https://example.test",
    proxy: { server: "http://proxy.example.test:8080" },
  },
});

try {
  await session.navigate("/login");
  await session.fill(
    defineDomLocator({ key: "login.email", kind: "label", text: "邮箱" }),
    "fixture@example.test",
  );
  await session.click({
    key: "login.submit",
    kind: "role",
    role: "button",
    name: "登录",
  });
} finally {
  await session.close();
}
```

## 安全与确定性

- browser session 只管理自己启动的进程，不附加或关闭用户现有浏览器。
- role、label、text、testId 是首选定位方式；CSS 仅作为产品 adapter 的显式 escape hatch。
- 点击、填写和读取操作要求 locator 恰好匹配一个元素，不使用隐式 `first()`。
- 依赖加载、启动、目标缺失、目标歧义和已关闭 session 使用稳定错误码。
- 错误摘要不包含 Playwright 原始 selector、URL 或页面文本；原始异常只保留为 `cause`。
- screenshot 和 trace 默认标记 `sensitive: true`，runner 应交给 Reporter 的保留策略处理。
- proxy 只作用于该 backend 拥有的 browser context；地址只允许 `http`、`https`、`socks5` 的
  scheme、host 与 port，不接受 path、query 或 fragment。
- HTTP(S) proxy 凭据必须使用独立 `username`/`password` 字段，不能嵌入 URL；Playwright 不支持
  SOCKS5 proxy authentication。代理字段拒绝控制字符，配置 proxy 后的底层启动错误不会作为
  `cause` 暴露，避免地址或凭据进入错误链。

## Reporter 映射

browser backend 返回的 `BrowserArtifact` 可以在 runner 中映射为通用 `SourceArtifact`：

```ts
const captured = await session.screenshot(absoluteOutputPath);
const sourceArtifact = {
  id: "browser-after",
  kind: captured.kind,
  phase: "after",
  title: "浏览器执行结果",
  captureStatus: "captured",
  sourcePath: captured.sourcePath,
  contentType: captured.contentType,
  capturedAt: captured.capturedAt,
  sensitive: captured.sensitive,
} as const;
```

浏览器二进制不在普通 Core 安装或默认源码包中。CI 的 browser package 契约使用注入的
fake Playwright module，因此不会下载或启动真实浏览器；真实浏览器 smoke 应放在单独、显式
启用的 lane。

## 观察、状态导出与制品消费

`session.observe({ limit })` 返回可停止的观察订阅；`stop()` 给出
`{ observations, dropped }`，用 requestId 区分同 URL 的并发请求。订阅有界，
session 关闭时释放；原始 URL、控制台内容和错误可能敏感，runner 负责脱敏及保留策略。

`session.elementState(locator)` 读取同一节点的 present/visible/enabled/clickable。
缺失目标是 `present: false`；歧义和驱动错误仍报错。两次属性读取并非原子 DOM
快照，clickable 也不表示已检查稳定性或遮挡。

`session.saveStorageState(absoluteJsonPath, { indexedDB: true })` 导出 cookies 和
localStorage；IndexedDB 需显式开启，sessionStorage 不导出。写入采用独占创建
0600 partial 文件再 rename，同一路径已有 partial 时拒绝覆盖。凭据等价文件通过
`context.storageStatePath` 重放，不进入 Git 或普通公开证据。

包当前保持 `private: true`，未声明 npm registry 已发布。跨仓消费者固定 framework
commit，在 `packages/browser-playwright` 执行 `npm ci`、`npm run build`、
`npm pack`，安装产出的 tgz，不链接源码目录。运行 `npm run test:packed` 可验证
隔离消费者会验证公开 exports、类型与运行契约；贡献归属保留在提交元数据中。
