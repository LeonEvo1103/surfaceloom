import path from "node:path";

import {
  browserEngines,
  browserCapabilities,
  type BrowserBackend,
  type BrowserContextOptions,
  type BrowserEngine,
  type BrowserLaunchOptions,
  type BrowserSession,
  type PlaywrightLoader,
} from "./contracts.js";
import { BrowserAutomationError } from "./errors.js";
import type {
  PlaywrightBrowserLike,
  PlaywrightContextLike,
  PlaywrightModuleLike,
} from "./playwright-shapes.js";
import { PlaywrightBrowserSession } from "./session.js";
import { browserProxyOptions } from "./proxy.js";

export class PlaywrightBrowserBackend implements BrowserBackend {
  public readonly capabilities = browserCapabilities;

  public constructor(
    private readonly loader: PlaywrightLoader = defaultPlaywrightLoader,
  ) {}

  public async launch(
    options: BrowserLaunchOptions = {},
  ): Promise<BrowserSession> {
    const engine = options.engine ?? "chromium";
    assertEngine(engine);
    const resolvedLaunchOptions = launchOptions(options);
    const resolvedContextOptions = contextOptions(options.context);
    const proxyConfigured = Object.hasOwn(resolvedContextOptions, "proxy");
    const playwright = await loadPlaywright(this.loader);
    let browser: PlaywrightBrowserLike | undefined;
    let context: PlaywrightContextLike | undefined;
    try {
      browser = await playwright[engine].launch(resolvedLaunchOptions);
      context = await browser.newContext(resolvedContextOptions);
      const page = await context.newPage();
      return new PlaywrightBrowserSession(engine, browser, context, page);
    } catch (error) {
      await cleanupFailedLaunch(context, browser);
      throw new BrowserAutomationError(
        "operationFailed",
        "Playwright could not launch an owned browser. Install the selected browser or provide channel/executablePath.",
        proxyConfigured ? undefined : error,
      );
    }
  }
}

async function defaultPlaywrightLoader(): Promise<unknown> {
  return import("playwright-core");
}

async function loadPlaywright(loader: PlaywrightLoader): Promise<PlaywrightModuleLike> {
  let candidate: unknown;
  try {
    candidate = await loader();
  } catch (error) {
    throw new BrowserAutomationError(
      "dependencyUnavailable",
      "The optional playwright-core dependency could not be loaded.",
      error,
    );
  }
  if (!isPlaywrightModule(candidate)) {
    throw new BrowserAutomationError(
      "dependencyUnavailable",
      "The loaded Playwright module does not expose Chromium, Firefox, and WebKit launchers.",
    );
  }
  return candidate;
}

function isPlaywrightModule(value: unknown): value is PlaywrightModuleLike {
  if (typeof value !== "object" || value === null) return false;
  const module = value as Record<string, unknown>;
  return browserEngines.every((engine) => {
    const browserType = module[engine];
    return typeof browserType === "object" && browserType !== null &&
      typeof (browserType as { launch?: unknown }).launch === "function";
  });
}

function assertEngine(engine: string): asserts engine is BrowserEngine {
  if (!(browserEngines as readonly string[]).includes(engine)) {
    throw new BrowserAutomationError(
      "invalidArgument",
      `Unsupported browser engine '${engine}'.`,
    );
  }
}

function launchOptions(options: BrowserLaunchOptions): Record<string, unknown> {
  if (options.headless !== undefined && typeof options.headless !== "boolean") {
    throw invalidLaunchOption("headless must be a boolean");
  }
  requireOptionalText(options.channel, "channel");
  requireOptionalText(options.executablePath, "executablePath");
  for (const argument of options.arguments ?? []) {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw invalidLaunchOption("arguments must be strings without NUL characters");
    }
  }
  return {
    headless: options.headless ?? true,
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    ...(options.executablePath === undefined
      ? {}
      : { executablePath: options.executablePath }),
    ...(options.arguments === undefined ? {} : { args: [...options.arguments] }),
  };
}

function contextOptions(options: BrowserContextOptions | undefined): Record<string, unknown> {
  if (options === undefined) return {};
  requireOptionalText(options.baseURL, "baseURL");
  requireOptionalText(options.locale, "locale");
  requireOptionalText(options.storageStatePath, "storageStatePath");
  if (
    options.viewport !== undefined &&
    (!Number.isInteger(options.viewport.width) || options.viewport.width <= 0 ||
      !Number.isInteger(options.viewport.height) || options.viewport.height <= 0)
  ) {
    throw invalidLaunchOption("viewport dimensions must be positive integers");
  }
  if (
    options.storageStatePath !== undefined &&
    !path.isAbsolute(options.storageStatePath)
  ) {
    throw invalidLaunchOption("storageStatePath must be absolute");
  }
  const proxy = browserProxyOptions(options);
  return {
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.viewport === undefined
      ? {}
      : { viewport: { width: options.viewport.width, height: options.viewport.height } }),
    ...(options.ignoreHTTPSErrors === undefined
      ? {}
      : { ignoreHTTPSErrors: options.ignoreHTTPSErrors }),
    ...(options.acceptDownloads === undefined
      ? {}
      : { acceptDownloads: options.acceptDownloads }),
    ...(options.storageStatePath === undefined
      ? {}
      : { storageState: options.storageStatePath }),
    ...(proxy === undefined ? {} : { proxy }),
  };
}

function requireOptionalText(value: string | undefined, name: string): void {
  if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
    throw invalidLaunchOption(`${name} must be a non-empty string`);
  }
}

function invalidLaunchOption(detail: string): BrowserAutomationError {
  return new BrowserAutomationError(
    "invalidArgument",
    `Invalid browser launch options: ${detail}.`,
  );
}

async function cleanupFailedLaunch(
  context: PlaywrightContextLike | undefined,
  browser: PlaywrightBrowserLike | undefined,
): Promise<void> {
  try {
    await context?.close();
  } catch {
    // The original launch error remains the primary diagnostic.
  }
  try {
    await browser?.close();
  } catch {
    // The original launch error remains the primary diagnostic.
  }
}
