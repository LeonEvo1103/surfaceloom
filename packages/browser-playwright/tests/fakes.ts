import type {
  PlaywrightBrowserLike,
  PlaywrightBrowserTypeLike,
  PlaywrightContextLike,
  PlaywrightLocatorLike,
  PlaywrightModuleLike,
  PlaywrightPageLike,
  PlaywrightTracingLike,
} from "../src/playwright-shapes.js";

export class FakeLocator implements PlaywrightLocatorLike {
  public matches = 1;
  public content: string | null = "fixture text";
  public waitFailure: unknown;
  public readonly calls: string[] = [];

  public first(): FakeLocator {
    this.calls.push("first");
    return this;
  }

  public async count(): Promise<number> {
    this.calls.push("count");
    return this.matches;
  }

  public async waitFor(options: { readonly state: string }): Promise<void> {
    this.calls.push(`wait:${options.state}`);
    if (this.waitFailure !== undefined) throw this.waitFailure;
  }

  public async click(): Promise<void> {
    this.calls.push("click");
  }

  public async fill(value: string): Promise<void> {
    this.calls.push(`fill:${value}`);
  }

  public async textContent(): Promise<string | null> {
    this.calls.push("text");
    return this.content;
  }
}

export class FakePage implements PlaywrightPageLike {
  public current = "about:blank";
  public pageTitle = "Fixture";
  public responseStatus = 200;
  public readonly target = new FakeLocator();
  public readonly resolutions: string[] = [];
  public screenshotPath: string | undefined;

  public async goto(url: string): Promise<{ status(): number }> {
    this.current = url;
    return { status: () => this.responseStatus };
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

  public async screenshot(options: { readonly path: string }): Promise<void> {
    this.screenshotPath = options.path;
  }
}

export class FakeTracing implements PlaywrightTracingLike {
  public starts = 0;
  public stopPath: string | undefined;

  public async start(): Promise<void> {
    this.starts += 1;
  }

  public async stop(options: { readonly path: string }): Promise<void> {
    this.stopPath = options.path;
  }
}

export class FakeContext implements PlaywrightContextLike {
  public readonly tracing = new FakeTracing();
  public readonly page = new FakePage();
  public closeCount = 0;
  public newPageFailure: unknown;

  public async newPage(): Promise<FakePage> {
    if (this.newPageFailure !== undefined) throw this.newPageFailure;
    return this.page;
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
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
