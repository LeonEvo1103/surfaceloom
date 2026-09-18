import path from "node:path";

import {
  browserEngines,
  type BrowserContextOptions,
  type BrowserEngine,
  type BrowserLaunchOptions,
  type PlaywrightLoader,
} from "./contracts.js";
import { BrowserAutomationError } from "./errors.js";
import { OwnedBrowserAcquisitionCleanup } from "./acquisition-cleanup.js";
import type { PlaywrightModuleLike } from "./playwright-shapes.js";
import { browserProxyOptions } from "./proxy.js";
import { PlaywrightBrowserSession } from "./session.js";

export type BrowserLaunchPreparation = () => Readonly<Record<string, unknown>>;

export async function defaultPlaywrightLoader(): Promise<unknown> {
  return import("playwright-core");
}

/** Shared owned-browser acquisition. The submission callback runs after all preparation. */
export async function launchOwnedBrowser(
  options: BrowserLaunchOptions,
  loader: PlaywrightLoader,
  beforeLaunch?: BrowserLaunchPreparation,
  acquisitionSignal?: AbortSignal,
): Promise<PlaywrightBrowserSession> {
  requireOptionalRecord(options, "options");
  const engine = options.engine ?? "chromium";
  assertEngine(engine);
  const resolvedLaunchOptions = launchOptions(options);
  const resolvedContextOptions = contextOptions(options.context);
  const proxyConfigured = Object.hasOwn(resolvedContextOptions, "proxy");
  const playwright = await loadPlaywright(loader);
  const cleanup = new OwnedBrowserAcquisitionCleanup();
  const stopCleanup = (): void => cleanup.stop();
  acquisitionSignal?.addEventListener("abort", stopCleanup, { once: true });
  if (acquisitionSignal?.aborted === true) cleanup.stop();
  // Submission-boundary errors (abort/deadline) must remain recognizable to
  // the runner and happen before the catch that normalizes Playwright failures.
  let submissionOptions: Readonly<Record<string, unknown>>;
  try { submissionOptions = beforeLaunch?.() ?? {}; }
  catch (error) {
    acquisitionSignal?.removeEventListener("abort", stopCleanup);
    throw error;
  }
  try {
    const browser = await playwright[engine].launch({ ...resolvedLaunchOptions, ...submissionOptions });
    cleanup.setBrowser(browser);
    throwIfAborted(acquisitionSignal);
    const context = await browser.newContext(resolvedContextOptions);
    cleanup.setContext(context);
    throwIfAborted(acquisitionSignal);
    const page = await context.newPage();
    throwIfAborted(acquisitionSignal);
    return new PlaywrightBrowserSession(engine, browser, context, page);
  } catch (error) {
    await cleanup.settle();
    throw new BrowserAutomationError(
      "operationFailed",
      "Playwright could not launch an owned browser. Install the selected browser or provide channel/executablePath.",
      proxyConfigured ? undefined : error,
    );
  } finally {
    acquisitionSignal?.removeEventListener("abort", stopCleanup);
  }
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
    return typeof browserType === "object" && browserType !== null
      && typeof (browserType as { launch?: unknown }).launch === "function";
  });
}

function assertEngine(engine: string): asserts engine is BrowserEngine {
  if (!(browserEngines as readonly string[]).includes(engine)) {
    throw new BrowserAutomationError("invalidArgument", `Unsupported browser engine '${engine}'.`);
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
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    ...(options.arguments === undefined ? {} : { args: [...options.arguments] }),
  };
}

function contextOptions(options: BrowserContextOptions | undefined): Record<string, unknown> {
  requireOptionalRecord(options, "context");
  if (options === undefined) return {};
  requireOptionalText(options.baseURL, "baseURL");
  requireOptionalText(options.locale, "locale");
  requireOptionalText(options.storageStatePath, "storageStatePath");
  requireOptionalRecord(options.viewport, "viewport");
  if (options.viewport !== undefined && (!Number.isInteger(options.viewport.width)
      || options.viewport.width <= 0 || !Number.isInteger(options.viewport.height)
      || options.viewport.height <= 0)) {
    throw invalidLaunchOption("viewport dimensions must be positive integers");
  }
  if (options.storageStatePath !== undefined && !path.isAbsolute(options.storageStatePath)) {
    throw invalidLaunchOption("storageStatePath must be absolute");
  }
  const proxy = browserProxyOptions(options);
  return {
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    ...(options.viewport === undefined ? {} : {
      viewport: { width: options.viewport.width, height: options.viewport.height },
    }),
    ...(options.ignoreHTTPSErrors === undefined ? {} : { ignoreHTTPSErrors: options.ignoreHTTPSErrors }),
    ...(options.acceptDownloads === undefined ? {} : { acceptDownloads: options.acceptDownloads }),
    ...(options.storageStatePath === undefined ? {} : { storageState: options.storageStatePath }),
    ...(proxy === undefined ? {} : { proxy }),
  };
}

function requireOptionalRecord(value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value))) {
    throw invalidLaunchOption(`${name} must be an object`);
  }
}

function requireOptionalText(value: string | undefined, name: string): void {
  if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
    throw invalidLaunchOption(`${name} must be a non-empty string`);
  }
}

function invalidLaunchOption(detail: string): BrowserAutomationError {
  return new BrowserAutomationError("invalidArgument", `Invalid browser launch options: ${detail}.`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason ?? new Error("Browser acquisition aborted.");
}
