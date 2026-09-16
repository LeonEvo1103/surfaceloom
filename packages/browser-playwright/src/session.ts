import type {
  BrowserArtifact,
  BrowserEngine,
  BrowserNavigateOptions,
  BrowserNavigationResult,
  BrowserOperationOptions,
  BrowserSession,
  DomLocator,
  DomWaitState,
} from "./contracts.js";
import { browserArtifact, prepareArtifactPath } from "./artifact.js";
import {
  BrowserAutomationError,
  isBrowserAutomationError,
} from "./errors.js";
import { resolveDomLocator } from "./locator.js";
import type {
  PlaywrightBrowserLike,
  PlaywrightContextLike,
  PlaywrightLocatorLike,
  PlaywrightPageLike,
} from "./playwright-shapes.js";

export class PlaywrightBrowserSession implements BrowserSession {
  public readonly engine: BrowserEngine;
  private closed = false;
  private traceStarted = false;

  public constructor(
    engine: BrowserEngine,
    private readonly browser: PlaywrightBrowserLike,
    private readonly context: PlaywrightContextLike,
    private readonly page: PlaywrightPageLike,
  ) {
    this.engine = engine;
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public async navigate(
    url: string,
    options: BrowserNavigateOptions = {},
  ): Promise<BrowserNavigationResult> {
    this.requireOpen();
    if (url.trim().length === 0) {
      throw new BrowserAutomationError("invalidArgument", "A navigation URL is required.");
    }
    return this.run("navigate", async () => {
      const response = await this.page.goto(url, operationOptions(options));
      return {
        url: this.page.url(),
        ...(response === null ? {} : { status: response.status() }),
      };
    });
  }

  public async click(
    locator: DomLocator,
    options: BrowserOperationOptions = {},
  ): Promise<void> {
    const target = await this.strictTarget(locator, "visible", options.timeoutMs);
    await this.run("click", () => target.click(timeoutOptions(options.timeoutMs)));
  }

  public async fill(
    locator: DomLocator,
    value: string,
    options: BrowserOperationOptions = {},
  ): Promise<void> {
    const target = await this.strictTarget(locator, "visible", options.timeoutMs);
    await this.run("fill", () => target.fill(value, timeoutOptions(options.timeoutMs)));
  }

  public async text(
    locator: DomLocator,
    options: BrowserOperationOptions = {},
  ): Promise<string> {
    const target = await this.strictTarget(locator, "attached", options.timeoutMs);
    return this.run("read text", async () =>
      (await target.textContent(timeoutOptions(options.timeoutMs))) ?? ""
    );
  }

  public async waitFor(
    locator: DomLocator,
    state: DomWaitState,
    options: BrowserOperationOptions = {},
  ): Promise<void> {
    this.requireOpen();
    const target = resolveDomLocator(this.page, locator);
    await this.run("wait for target", () =>
      target.waitFor({ state, ...timeoutOptions(options.timeoutMs) })
    );
  }

  public async title(): Promise<string> {
    this.requireOpen();
    return this.run("read title", () => this.page.title());
  }

  public currentURL(): string {
    this.requireOpen();
    return this.page.url();
  }

  public async screenshot(
    outputPath: string,
    fullPage = false,
  ): Promise<BrowserArtifact> {
    this.requireOpen();
    const target = await prepareArtifactPath(outputPath, ".png");
    await this.run("capture screenshot", () =>
      this.page.screenshot({ path: target, type: "png", fullPage })
    );
    return browserArtifact("screenshot", target, "image/png");
  }

  public async startTrace(): Promise<void> {
    this.requireOpen();
    if (this.traceStarted) {
      throw new BrowserAutomationError("artifactState", "Browser tracing is already active.");
    }
    await this.run("start trace", () =>
      this.context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    );
    this.traceStarted = true;
  }

  public async stopTrace(outputPath: string): Promise<BrowserArtifact> {
    this.requireOpen();
    if (!this.traceStarted) {
      throw new BrowserAutomationError("artifactState", "Browser tracing is not active.");
    }
    const target = await prepareArtifactPath(outputPath, ".zip");
    try {
      await this.run("stop trace", () => this.context.tracing.stop({ path: target }));
    } finally {
      this.traceStarted = false;
    }
    return browserArtifact("trace", target, "application/zip");
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const failures: unknown[] = [];
    try {
      await this.context.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.browser.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new BrowserAutomationError(
        "operationFailed",
        "The owned browser session did not close cleanly.",
        new AggregateError(failures),
      );
    }
  }

  private async strictTarget(
    locator: DomLocator,
    state: "attached" | "visible",
    timeoutMs: number | undefined,
  ): Promise<PlaywrightLocatorLike> {
    this.requireOpen();
    const target = resolveDomLocator(this.page, locator);
    const waitOptions = { state, ...timeoutOptions(timeoutMs) };
    try {
      // first() is used only to observe availability; the action still targets the
      // original strict locator after cardinality is proven below.
      await target.first().waitFor(waitOptions);
    } catch (error) {
      throw new BrowserAutomationError(
        "targetNotFound",
        `DOM target '${locator.key}' did not become ${state}.`,
        error,
      );
    }
    const count = await this.run("count targets", () => target.count());
    if (count !== 1) {
      throw new BrowserAutomationError(
        "ambiguousTarget",
        `DOM target '${locator.key}' matched ${count} elements; exactly one is required.`,
      );
    }
    return target;
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new BrowserAutomationError("sessionClosed", "The browser session is closed.");
    }
  }

  private async run<T>(operation: string, action: () => Promise<T>): Promise<T> {
    this.requireOpen();
    try {
      return await action();
    } catch (error) {
      if (isBrowserAutomationError(error)) throw error;
      throw new BrowserAutomationError(
        "operationFailed",
        `The browser could not ${operation}.`,
        error,
      );
    }
  }
}

function timeoutOptions(timeoutMs: number | undefined): { readonly timeout?: number } {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new BrowserAutomationError(
      "invalidArgument",
      "A browser operation timeout must be a non-negative finite number.",
    );
  }
  return timeoutMs === undefined ? {} : { timeout: timeoutMs };
}

function operationOptions(
  options: BrowserNavigateOptions,
): { readonly timeout?: number; readonly waitUntil?: string } {
  return {
    ...timeoutOptions(options.timeoutMs),
    ...(options.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
  };
}
