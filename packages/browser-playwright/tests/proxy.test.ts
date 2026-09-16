import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserAutomationError,
  PlaywrightBrowserBackend,
  type BrowserContextOptions,
} from "../src/index.js";
import { FakeBrowserType, fakePlaywright } from "./fakes.js";

test("passes an authenticated proxy through to the owned context", async () => {
  const module = fakePlaywright();
  await new PlaywrightBrowserBackend(async () => module).launch({
    context: {
      locale: "zh-CN",
      proxy: {
        server: "http://proxy.test:8080",
        bypass: "localhost,127.0.0.1",
        username: "fixture-user",
        password: "fixture-secret",
      },
    },
  });

  assert.deepEqual((module.chromium as FakeBrowserType).browser.contextOptions, {
    locale: "zh-CN",
    proxy: {
      server: "http://proxy.test:8080",
      bypass: "localhost,127.0.0.1",
      username: "fixture-user",
      password: "fixture-secret",
    },
  });
});

test("supports an anonymous socks5 proxy and omits proxy when unset", async () => {
  const socks = fakePlaywright();
  await new PlaywrightBrowserBackend(async () => socks).launch({
    context: { proxy: { server: "socks5://proxy.test:1080" } },
  });
  assert.deepEqual((socks.chromium as FakeBrowserType).browser.contextOptions, {
    proxy: { server: "socks5://proxy.test:1080" },
  });

  const direct = fakePlaywright();
  await new PlaywrightBrowserBackend(async () => direct).launch({
    context: { baseURL: "https://example.test" },
  });
  const directOptions = (direct.chromium as FakeBrowserType).browser.contextOptions ?? {};
  assert.equal(Object.hasOwn(directOptions, "proxy"), false);
});

test("rejects invalid proxy values before loading Playwright", async () => {
  let loads = 0;
  const backend = new PlaywrightBrowserBackend(async () => {
    loads += 1;
    return fakePlaywright();
  });
  const invalidServers = [
    "proxy.test:8080",
    "ftp://proxy.test:2121",
    "socks5:",
    "   ",
    "http://ok.test:1\n",
    "   http://evil.test:80",
    "http://ho\tst:8080",
    "http://proxy.test:8080/path",
    "http://proxy.test:8080?mode=direct",
    "http://proxy.test:8080#fragment",
    "http:proxy.test:8080",
    "http:\\proxy.test:8080",
    "http://proxy.test:8080/.",
    "http://proxy.test:8080/foo/..",
  ];

  for (const server of invalidServers) {
    await assert.rejects(
      backend.launch({ context: { proxy: { server } } }),
      (error: unknown) =>
        error instanceof BrowserAutomationError &&
        error.code === "invalidArgument" &&
        !error.message.includes(server),
    );
  }
  await assert.rejects(
    backend.launch({
      context: { proxy: { server: "http://fixture-user:fixture-secret@proxy.test:8080" } },
    }),
    (error: unknown) =>
      error instanceof BrowserAutomationError &&
      error.code === "invalidArgument" &&
      !error.message.includes("fixture-secret"),
  );
  await assert.rejects(
    backend.launch({
      context: { proxy: { server: "http://proxy.test:8080", username: "fixture-user" } },
    }),
    /must be provided together/u,
  );
  await assert.rejects(
    backend.launch({
      context: { proxy: { server: "http://proxy.test:8080", bypass: "" } },
    }),
    /proxy.bypass must be a non-empty string/u,
  );
  await assert.rejects(
    backend.launch({
      context: {
        proxy: {
          server: "socks5://proxy.test:1080",
          username: "fixture-user",
          password: "fixture-secret",
        },
      },
    }),
    /socks5 proxy authentication is not supported/u,
  );
  for (const proxy of [
    { server: "http://proxy.test:8080", bypass: "localhost\n*" },
    { server: "http://proxy.test:8080", username: "user\0name", password: "secret" },
    { server: "http://proxy.test:8080", username: "user", password: "secret\r\n" },
  ]) {
    await assert.rejects(
      backend.launch({ context: { proxy } }),
      /must not contain control characters/u,
    );
  }
  const hostile = { locale: "zh-CN", proxy: null } as unknown as BrowserContextOptions;
  await assert.rejects(backend.launch({ context: hostile }), /proxy must be an object/u);
  assert.equal(loads, 0);
});

test("does not retain a raw Playwright cause when a proxy is configured", async () => {
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  browserType.browser.context.newPageFailure = new Error(
    "proxy password fixture-secret failed",
  );

  await assert.rejects(
    new PlaywrightBrowserBackend(async () => module).launch({
      context: {
        proxy: {
          server: "http://proxy.test:8080",
          username: "fixture-user",
          password: "fixture-secret",
        },
      },
    }),
    (error: unknown) =>
      error instanceof BrowserAutomationError &&
      error.code === "operationFailed" &&
      !error.message.includes("fixture-secret") &&
      error.cause === undefined,
  );
  assert.equal(browserType.browser.context.closeCount, 1);
  assert.equal(browserType.browser.closeCount, 1);
});

test("uses an immutable proxy marker when Playwright mutates context options", async () => {
  const module = fakePlaywright();
  const browserType = module.chromium as FakeBrowserType;
  browserType.browser.newContext = async (options) => {
    delete options["proxy"];
    throw new Error("proxy password=fixture-secret failed");
  };

  await assert.rejects(
    new PlaywrightBrowserBackend(async () => module).launch({
      context: {
        proxy: {
          server: "http://proxy.test:8080",
          username: "fixture-user",
          password: "fixture-secret",
        },
      },
    }),
    (error: unknown) =>
      error instanceof BrowserAutomationError &&
      error.code === "operationFailed" &&
      !error.message.includes("fixture-secret") &&
      error.cause === undefined,
  );
  assert.equal(browserType.browser.closeCount, 1);
});

test("snapshots proxy fields once before validation and forwarding", async () => {
  const module = fakePlaywright();
  let proxyReads = 0;
  let serverReads = 0;
  const changingProxy = {
    get server() {
      serverReads += 1;
      return serverReads === 1
        ? "http://proxy.test:8080"
        : "http://fixture-user:fixture-secret@evil.test:8080";
    },
  };
  const context = {
    get proxy() {
      proxyReads += 1;
      return changingProxy;
    },
  };

  await new PlaywrightBrowserBackend(async () => module).launch({ context });

  assert.equal(proxyReads, 1);
  assert.equal(serverReads, 1);
  assert.deepEqual((module.chromium as FakeBrowserType).browser.contextOptions, {
    proxy: { server: "http://proxy.test:8080" },
  });
});

test("normalizes throwing proxy accessors to a non-sensitive argument error", async () => {
  let loads = 0;
  const backend = new PlaywrightBrowserBackend(async () => {
    loads += 1;
    return fakePlaywright();
  });
  const throwingProxy = {
    get server(): string {
      throw new Error("fixture-secret");
    },
  };
  const throwingContext = {
    get proxy(): never {
      throw new Error("another-secret");
    },
  };
  const nonSensitive = (error: unknown): boolean =>
    error instanceof BrowserAutomationError &&
    error.code === "invalidArgument" &&
    !error.message.includes("secret") &&
    error.cause === undefined;

  await assert.rejects(backend.launch({ context: { proxy: throwingProxy } }), nonSensitive);
  await assert.rejects(backend.launch({ context: throwingContext }), nonSensitive);
  assert.equal(loads, 0);
});
