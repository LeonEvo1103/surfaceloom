import assert from "node:assert/strict";
import test from "node:test";

import { defineCaseSpec } from "../src/index.js";

const validSpec = {
  id: "desktop.window.close-hides",
  locale: "zh-CN",
  platforms: ["macos"],
  suite: { id: "app.lifecycle", name: "窗口生命周期" },
  name: "Cmd+W 隐藏窗口但不退出进程",
  sourceName: "Cmd+W hides the window without quitting",
  intent: "验证用户关闭主窗口后仍能从 Dock 恢复会话，避免把关闭窗口误实现为退出应用。",
  preconditions: [{ id: "main-window-visible", text: "应用已启动并显示唯一主窗口" }],
  acceptanceCriteria: [
    { id: "window-hidden", text: "主窗口变为不可见" },
    { id: "process-alive", text: "应用进程保持运行" },
  ],
  sideEffect: "reversible",
  tags: ["macos", "release-candidate"],
} as const;

test("defines and deeply freezes a case specification", () => {
  const spec = defineCaseSpec(validSpec);

  assert.equal(spec.name, "Cmd+W 隐藏窗口但不退出进程");
  assert.equal(Object.isFrozen(spec), true);
  assert.equal(Object.isFrozen(spec.platforms), true);
  assert.equal(Object.isFrozen(spec.suite), true);
  assert.equal(Object.isFrozen(spec.preconditions), true);
  assert.equal(Object.isFrozen(spec.preconditions[0]), true);
  assert.equal(Object.isFrozen(spec.acceptanceCriteria), true);
  assert.equal(Object.isFrozen(spec.tags), true);
});

test("requires a non-empty, unique list of supported desktop platforms", () => {
  assert.throws(
    () => defineCaseSpec({ ...validSpec, platforms: [] }),
    /at least one platform/,
  );
  assert.throws(
    () => defineCaseSpec({ ...validSpec, platforms: ["macos", "macos"] }),
    /Duplicate case platform: macos/,
  );
  assert.throws(
    () => defineCaseSpec({ ...validSpec, platforms: ["linux"] } as never),
    /Unknown test platform: linux/,
  );
  assert.throws(
    () => defineCaseSpec({ ...validSpec, platforms: "macos" } as never),
    /Case platforms must be an array/,
  );
});

test("accepts web as a first-class platform alongside the desktop platforms", () => {
  const webOnly = defineCaseSpec({
    ...validSpec,
    id: "web.session.restore",
    platforms: ["web"],
    suite: { id: "web.session", name: "网页会话" },
    name: "刷新页面后仍保留登录会话",
    sourceName: "Session survives a page reload",
    intent: "验证网页端刷新后不会丢失登录态，避免用户被迫重新登录。",
    preconditions: [{ id: "signed-in", text: "用户已在网页端完成登录" }],
    acceptanceCriteria: [{ id: "session-kept", text: "刷新后页面仍显示已登录状态" }],
    tags: ["web"],
  });

  assert.deepEqual([...webOnly.platforms], ["web"]);

  const mixed = defineCaseSpec({ ...validSpec, platforms: ["web", "macos"] });

  assert.deepEqual([...mixed.platforms], ["web", "macos"]);
  assert.equal(Object.isFrozen(mixed.platforms), true);
});

test("still rejects a duplicated web platform entry", () => {
  assert.throws(
    () => defineCaseSpec({ ...validSpec, platforms: ["web", "web"] }),
    /Duplicate case platform: web/,
  );
});

test("requires stable identity, a name, original intent, and acceptance criteria", () => {
  assert.throws(
    () => defineCaseSpec({ ...validSpec, id: "/tmp/local-case" }),
    /stable machine-id character set/,
  );
  assert.throws(
    () => defineCaseSpec({ ...validSpec, name: " " }),
    /case name must not be empty/,
  );
  assert.throws(
    () => defineCaseSpec({ ...validSpec, intent: "" }),
    /case intent must not be empty/,
  );
  assert.throws(
    () => defineCaseSpec({ ...validSpec, acceptanceCriteria: [] }),
    /at least one acceptance criterion/,
  );
});

test("rejects empty or duplicate semantic list entries", () => {
  assert.throws(
    () => defineCaseSpec({
      ...validSpec,
      preconditions: [{ id: "empty", text: "" }],
    }),
    /precondition must not be empty/,
  );
  assert.throws(
    () => defineCaseSpec({
      ...validSpec,
      acceptanceCriteria: [
        { id: "window-hidden", text: "窗口隐藏" },
        { id: "window-hidden", text: "窗口仍然隐藏" },
      ],
    }),
    /Duplicate acceptance criterion id/,
  );
});

test("enforces Chinese canonical text when locale is zh-CN", () => {
  assert.throws(
    () => defineCaseSpec({ ...validSpec, name: "Window closes" }),
    /case name must contain Chinese text/,
  );
  assert.doesNotThrow(() => defineCaseSpec({
    ...validSpec,
    locale: "en-US",
    suite: { id: "app.lifecycle", name: "Window lifecycle" },
    name: "Window closes",
    intent: "Protect the expected application lifecycle behavior.",
    preconditions: [{ id: "visible", text: "The main window is visible." }],
    acceptanceCriteria: [{ id: "hidden", text: "The main window is hidden." }],
  }));
});

test("rejects unknown fields instead of producing a spec Reporter cannot accept", () => {
  assert.throws(
    () => defineCaseSpec({ ...validSpec, unexpected: true }),
    /case spec contains an unknown field: unexpected/,
  );
  assert.throws(
    () => defineCaseSpec({
      ...validSpec,
      suite: { ...validSpec.suite, productName: "fixture" },
    }),
    /case suite contains an unknown field: productName/,
  );
  assert.throws(
    () => defineCaseSpec({
      ...validSpec,
      acceptanceCriteria: [{
        ...validSpec.acceptanceCriteria[0],
        observed: true,
      }],
    }),
    /acceptance criterion contains an unknown field: observed/,
  );
});

test("rejects malformed JSON field types with a stable validation error", () => {
  assert.throws(
    () => defineCaseSpec({ ...validSpec, id: 42 } as never),
    /case id must be a string/,
  );
  assert.throws(
    () => defineCaseSpec({
      ...validSpec,
      acceptanceCriteria: [{ id: "observable", text: false }],
    } as never),
    /acceptance criterion must be a string/,
  );
});
