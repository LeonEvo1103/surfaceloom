import { chmod, writeFile } from "node:fs/promises";

import type {
  PlaywrightBrowserLike,
  PlaywrightBrowserTypeLike,
  PlaywrightContextLike,
  PlaywrightElementHandleLike,
  PlaywrightLocatorLike,
  PlaywrightModuleLike,
  PlaywrightPageLike,
  PlaywrightTracingLike,
} from "../src/playwright-shapes.js";

import { FakeEmitter } from "./event-fakes.js";
import { FakeLocator } from "./dom-fakes.js";
export { FakeEmitter } from "./event-fakes.js";
export { FakeElementHandle, FakeLocator } from "./dom-fakes.js";

export class FakePage implements PlaywrightPageLike {
  public current = "about:blank";
  public pageTitle = "Fixture";
  public responseStatus = 200;
  public readonly target = new FakeLocator();
  public readonly resolutions: string[] = [];
  public screenshotPath: string | undefined;
  public screenshotOptions: Record<string, unknown> | undefined;
  public readonly events = new FakeEmitter();
  /** Emitted while goto() runs, so tests can drive events from inside an action. */
  public readonly gotoEmissions: Array<{
    readonly event: string;
    readonly payload: unknown;
  }> = [];

  public async goto(url: string): Promise<{ status(): number }> {
    this.current = url;
    for (const emission of this.gotoEmissions) {
      this.events.emit(emission.event, emission.payload);
    }
    return { status: () => this.responseStatus };
  }

  /** Makes a single listener registration fail, mid-way through attaching. */
  public onFailure: { readonly event: string; readonly error: unknown } | undefined;

  public on(event: string, handler: (payload: unknown) => void): void {
    if (this.onFailure !== undefined && this.onFailure.event === event) {
      throw this.onFailure.error;
    }
    this.events.on(event, handler);
  }

  public off(event: string, handler: (payload: unknown) => void): void {
    this.events.off(event, handler);
  }

  public emit(event: string, payload: unknown): void {
    this.events.emit(event, payload);
  }

  public async title(): Promise<string> {
    return this.pageTitle;
  }

  public url(): string {
    return this.current;
  }

  public getByRole(
    role: string,
    options: { readonly name?: string; readonly exact?: boolean } = {},
  ): FakeLocator {
    this.resolutions.push(`role:${role}:${options.name ?? ""}:${String(options.exact)}`);
    return this.target;
  }

  public getByLabel(
    text: string,
    options: { readonly exact?: boolean } = {},
  ): FakeLocator {
    this.resolutions.push(`label:${text}:${String(options.exact)}`);
    return this.target;
  }

  public getByText(
    text: string,
    options: { readonly exact?: boolean } = {},
  ): FakeLocator {
    this.resolutions.push(`text:${text}:${String(options.exact)}`);
    return this.target;
  }

  public getByTestId(value: string): FakeLocator {
    this.resolutions.push(`testId:${value}`);
    return this.target;
  }

  public locator(selector: string): FakeLocator {
    this.resolutions.push(`css:${selector}`);
    return this.target;
  }

  public async screenshot(options: {
    readonly path: string;
    readonly type: "png";
    readonly fullPage: boolean;
    readonly timeout?: number;
  }): Promise<void> {
    this.screenshotPath = options.path;
    this.screenshotOptions = { ...options };
    await writeUnrestrictedArtifact(options.path, "fake-png-bytes");
  }
}

/**
 * playwright-core writes screenshots, traces, and storage state with a plain
 * `fs.promises.writeFile(path, ...)` - no mode, no chmod - so the file lands at the
 * ambient umask. The fakes reproduce that by writing real bytes and then forcing
 * 0o644, which keeps the permission assertions umask-independent instead of letting
 * a strict umask on the test machine hide a missing restriction.
 */
async function writeUnrestrictedArtifact(target: string, contents: string): Promise<void> {
  await writeFile(target, contents);
  if (process.platform !== "win32") await chmod(target, 0o644);
}

export class FakeTracing implements PlaywrightTracingLike {
  public starts = 0;
  public stopPath: string | undefined;

  public async start(): Promise<void> {
    this.starts += 1;
  }

  public async stop(options: { readonly path: string }): Promise<void> {
    this.stopPath = options.path;
    await writeUnrestrictedArtifact(options.path, "fake-trace-bytes");
  }
}

export class FakeContext implements PlaywrightContextLike {
  public async storageState(): Promise<unknown> {
    return { cookies: [], origins: [] };
  }
  public readonly tracing = new FakeTracing();
  public readonly page = new FakePage();
  public readonly events = new FakeEmitter();
  public closeCount = 0;
  public newPageFailure: unknown;
  public readonly storageStateCalls: Record<string, unknown>[] = [];
  /** Returned verbatim, so suites can assert what actually reached disk. */
  public storageStateResult: unknown = { cookies: [], origins: [] };

  public async newPage(): Promise<FakePage> {
    if (this.newPageFailure !== undefined) throw this.newPageFailure;
    return this.page;
  }

  public async storageState(
    options: { readonly indexedDB?: boolean },
  ): Promise<unknown> {
    this.storageStateCalls.push({ ...options });
    return this.storageStateResult;
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }

  public on(event: string, handler: (payload: unknown) => void): void {
    this.events.on(event, handler);
  }

  public off(event: string, handler: (payload: unknown) => void): void {
    this.events.off(event, handler);
  }
}

export class FakeBrowser implements PlaywrightBrowserLike {
  public readonly context = new FakeContext();
  public contextOptions: Record<string, unknown> | undefined;
  public closeCount = 0;

  public async newContext(options: Record<string, unknown>): Promise<FakeContext> {
    this.contextOptions = options;
    return this.context;
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }
}

export class FakeBrowserType implements PlaywrightBrowserTypeLike {
  public readonly browser = new FakeBrowser();
  public launchOptions: Record<string, unknown> | undefined;

  public async launch(options: Record<string, unknown>): Promise<FakeBrowser> {
    this.launchOptions = options;
    return this.browser;
  }
}

export function fakePlaywright(): PlaywrightModuleLike {
  return {
    chromium: new FakeBrowserType(),
    firefox: new FakeBrowserType(),
    webkit: new FakeBrowserType(),
  };
}
