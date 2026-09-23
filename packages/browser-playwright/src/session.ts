import type {
  BrowserArtifact, BrowserEngine, BrowserNavigateOptions, BrowserNavigationResult,
  BrowserObservationHandle, BrowserObservationOptions, BrowserOperationOptions,
  BrowserSession, BrowserStorageStateOptions, DomElementState, DomLocator, DomWaitState,
} from "./contracts.js";
import type { BrowserAction, SurfaceBackendCall } from "@surfaceloom/test";
import { BrowserAutomationError, isBrowserAutomationError } from "./errors.js";
import { resolveDomLocator } from "./locator.js";
import type { PlaywrightBrowserLike, PlaywrightContextLike, PlaywrightLocatorLike, PlaywrightPageLike } from "./playwright-shapes.js";
import { readElementState } from "./element-state.js";
import { SessionArtifacts } from "./session-artifacts.js";
import { SessionObservations } from "./session-observations.js";
import { operationOptions, timeoutOptions } from "./session-operations.js";
import { invokeSurfaceAction } from "./v3-session-operations.js";

export class PlaywrightBrowserSession implements BrowserSession {
  public readonly engine: BrowserEngine;
  private closed = false;
  private readonly observations: SessionObservations;
  private readonly artifacts: SessionArtifacts;

  public constructor(
    engine: BrowserEngine,
    private readonly browser: PlaywrightBrowserLike,
    private readonly context: PlaywrightContextLike,
    private readonly page: PlaywrightPageLike,
  ) {
    this.engine = engine;
    this.observations = new SessionObservations(page);
    this.artifacts = new SessionArtifacts(page, context, (operation, action) => this.run(operation, action));
  }

  public get isClosed(): boolean { return this.closed; }

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

  public async elementState(locator: DomLocator, options: BrowserOperationOptions = {}): Promise<DomElementState> {
    this.requireOpen();
    return readElementState(this.page, locator, options, (operation, action) => this.run(operation, action));
  }

  public async title(): Promise<string> {
    this.requireOpen();
    return this.run("read title", () => this.page.title());
  }

  public currentURL(): string {
    this.requireOpen();
    return this.page.url();
  }

  public screenshot(
    outputPath: string,
    fullPage = false,
    options: BrowserOperationOptions = {},
  ): Promise<BrowserArtifact> {
    return this.run("capture screenshot", () =>
      this.artifacts.screenshot(outputPath, fullPage, options));
  }

  public startTrace(): Promise<void> {
    return this.run("start trace", () => this.artifacts.startTrace());
  }

  public stopTrace(outputPath: string): Promise<BrowserArtifact> {
    return this.run("stop trace", () => this.artifacts.stopTrace(outputPath));
  }

  public saveStorageState(outputPath: string, options: BrowserStorageStateOptions = {}): Promise<BrowserArtifact> {
    return this.run("save storage state", () => this.artifacts.saveStorageState(outputPath, options));
  }

  public observe(options: BrowserObservationOptions = {}): BrowserObservationHandle {
    this.requireOpen();
    return this.observations.observe(options);
  }

  /** v3 operations keep preparation outside the single irreversible submission boundary. */
  public invokeSurface(action: BrowserAction, call: SurfaceBackendCall): Promise<unknown> {
    return invokeSurfaceAction(this.page, action, call, () => this.requireOpen());
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    // Detach before the page and context go away, so no listener outlives the session.
    this.observations.stopAll();
    this.closed = true;
    // Context is owned by the browser, so closing both concurrently races the
    // parent teardown against Target.disposeBrowserContext in real Chromium.
    // Keep the child-before-parent order, while still attempting the parent if
    // context cleanup fails.
    const failures: unknown[] = [];
    try { await this.context.close(); } catch (error) { failures.push(error); }
    try { await this.browser.close(); } catch (error) { failures.push(error); }
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
