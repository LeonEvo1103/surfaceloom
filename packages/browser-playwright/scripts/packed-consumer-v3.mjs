import assert from "node:assert/strict";
import path from "node:path";

import { createPlaywrightBrowserRunOptions } from "@surfaceloom/browser-playwright/v3";

const effects = [{ resource: "browser.session", operation: "execute", boundary: "local",
  securitySensitive: false, recovery: "unknown" }];
const policy = { maximumSideEffect: "writesLocal", grants: [] };
const options = createPlaywrightBrowserRunOptions({
  spec: {
    id: "packed.playwright.preset", locale: "zh-CN", platforms: ["web"],
    suite: { id: "packed.playwright", name: "打包消费契约" },
    name: "公共浏览器预设可由仓库外消费",
    intent: "验证打包产物只通过公开入口创建 v3 运行配置。",
    preconditions: [],
    acceptanceCriteria: [{ id: "verified", text: "公共入口返回标准运行配置。" }],
    sideEffect: "writesLocal",
  },
  run: { id: "run-packed-playwright-preset", title: "Packed Playwright preset",
    app: { id: "packed-fixture", name: "Packed Fixture" } },
  outputDirectory: path.resolve("v3-report"),
  effects,
  policy,
  runner: { hostOS: "linux" },
});

assert.equal(options.runnerHostId, "surfaceloom.runner");
assert.equal(options.surfaces[0].requirement.surfaceId, "page");
assert.equal(options.execution.policy, policy);
assert.deepEqual(options.execution.plan.effectDeclaration.effects, effects);
