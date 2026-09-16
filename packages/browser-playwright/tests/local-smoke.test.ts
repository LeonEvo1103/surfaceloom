import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserAutomationError,
  PlaywrightBrowserBackend,
} from "../src/index.js";

const localTest = process.env.SURFACELOOM_BROWSER_SMOKE === "1"
  ? test
  : test.skip;

localTest("system Chrome runs navigation, form, role, label, and test-id cases", async () => {
  const browser = await new PlaywrightBrowserBackend().launch({
    engine: "chromium",
    channel: "chrome",
    headless: true,
    context: { locale: "zh-CN" },
  });
  try {
    await browser.navigate(fixtureURL());
    assert.equal(await browser.title(), "SurfaceLoom Browser Smoke");
    await browser.fill(
      { key: "profile.name", kind: "label", text: "姓名" },
      "SurfaceLoom",
    );
    await browser.click({
      key: "profile.submit",
      kind: "role",
      role: "button",
      name: "提交",
      exact: true,
    });
    await browser.waitFor(
      { key: "profile.result", kind: "testId", value: "result" },
      "visible",
    );
    assert.equal(
      await browser.text({ key: "profile.result", kind: "testId", value: "result" }),
      "已提交：SurfaceLoom",
    );
  } finally {
    await browser.close();
  }
});

localTest("system Chrome preserves strict matching and owned-session lifecycle", async () => {
  const browser = await new PlaywrightBrowserBackend().launch({
    channel: "chrome",
    headless: true,
  });
  await browser.navigate(duplicateButtonsURL());
  await assert.rejects(
    browser.click({ key: "duplicate.action", kind: "text", text: "重复操作" }),
    (error: unknown) =>
      error instanceof BrowserAutomationError && error.code === "ambiguousTarget",
  );
  await browser.close();
  assert.equal(browser.isClosed, true);
  await assert.rejects(browser.title(), (error: unknown) =>
    error instanceof BrowserAutomationError && error.code === "sessionClosed"
  );
});

function fixtureURL(): string {
  const html = `<!doctype html>
    <html lang="zh-CN"><head><title>SurfaceLoom Browser Smoke</title></head>
    <body><label>姓名 <input id="name"></label><button id="submit">提交</button>
    <p data-testid="result" hidden></p><script>
      document.querySelector('#submit').addEventListener('click', () => {
        const result = document.querySelector('[data-testid="result"]');
        result.textContent = '已提交：' + document.querySelector('#name').value;
        result.hidden = false;
      });
    </script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function duplicateButtonsURL(): string {
  const html = "<!doctype html><button>重复操作</button><button>重复操作</button>";
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
