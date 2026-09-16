export interface PlaywrightLocatorLike {
  first(): PlaywrightLocatorLike;
  count(): Promise<number>;
  waitFor(options: { readonly state: string; readonly timeout?: number }): Promise<void>;
  click(options: { readonly timeout?: number }): Promise<void>;
  fill(value: string, options: { readonly timeout?: number }): Promise<void>;
  textContent(options: { readonly timeout?: number }): Promise<string | null>;
}

export interface PlaywrightResponseLike {
  status(): number;
}

export interface PlaywrightPageLike {
  goto(
    url: string,
    options: { readonly timeout?: number; readonly waitUntil?: string },
  ): Promise<PlaywrightResponseLike | null>;
  title(): Promise<string>;
  url(): string;
  getByRole(
    role: string,
    options?: { readonly name?: string; readonly exact?: boolean },
  ): PlaywrightLocatorLike;
  getByLabel(
    text: string,
    options?: { readonly exact?: boolean },
  ): PlaywrightLocatorLike;
  getByText(
    text: string,
    options?: { readonly exact?: boolean },
  ): PlaywrightLocatorLike;
  getByTestId(value: string): PlaywrightLocatorLike;
  locator(selector: string): PlaywrightLocatorLike;
  screenshot(options: {
    readonly path: string;
    readonly type: "png";
    readonly fullPage: boolean;
  }): Promise<unknown>;
}

export interface PlaywrightTracingLike {
  start(options: {
    readonly screenshots: boolean;
    readonly snapshots: boolean;
    readonly sources: boolean;
  }): Promise<void>;
  stop(options: { readonly path: string }): Promise<void>;
}

export interface PlaywrightContextLike {
  readonly tracing: PlaywrightTracingLike;
  newPage(): Promise<PlaywrightPageLike>;
  close(): Promise<void>;
}

export interface PlaywrightBrowserLike {
  newContext(options: Record<string, unknown>): Promise<PlaywrightContextLike>;
  close(): Promise<void>;
}

export interface PlaywrightBrowserTypeLike {
  launch(options: Record<string, unknown>): Promise<PlaywrightBrowserLike>;
}

export interface PlaywrightModuleLike {
  readonly chromium: PlaywrightBrowserTypeLike;
  readonly firefox: PlaywrightBrowserTypeLike;
  readonly webkit: PlaywrightBrowserTypeLike;
}
