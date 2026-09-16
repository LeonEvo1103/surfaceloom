import type { PlaywrightBrowserLike, PlaywrightContextLike, PlaywrightPageLike, PlaywrightTracingLike } from "../src/playwright-shapes.js";
import { PlaywrightBrowserSession } from "../src/session.js";
import { FakePage } from "./fakes.js";

interface StorageStateOptions {
  readonly indexedDB?: boolean;
}

/**
 * Local storage-state doubles keep this capability independent of the shared
 * fakes, which other browser contract suites extend for their own surfaces.
 */
class StorageStateContext implements PlaywrightContextLike {
  public on(event: string, handler: (payload: unknown) => void): void {
    this.page.on(event, handler);
  }

  public off(event: string, handler: (payload: unknown) => void): void {
    this.page.off(event, handler);
  }
  public readonly tracing: PlaywrightTracingLike = {
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
  };
  public readonly page: PlaywrightPageLike = new FakePage();
  /** Full option objects, so opt-in keys can be asserted as present or absent. */
  public readonly storageStateCalls: StorageStateOptions[] = [];
  public storageStateFailure: unknown;
  public closeCount = 0;
  /**
   * A distinctive payload returned verbatim and, unlike real Playwright, never
   * written anywhere. Matching bytes on disk therefore prove this package wrote
   * them from the returned value rather than delegating to the library.
   */
  public storageStateResult: unknown = {
    cookies: [{ name: "sid", value: "fixture-session", domain: "example.test" }],
    origins: [{ origin: "https://example.test", localStorage: [{ name: "k", value: "v" }] }],
  };

  public async newPage(): Promise<PlaywrightPageLike> {
    return this.page;
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }

  public async storageState(options: StorageStateOptions): Promise<unknown> {
    if (this.storageStateFailure !== undefined) throw this.storageStateFailure;
    this.storageStateCalls.push({ ...options });
    return this.storageStateResult;
  }
}

class StorageStateBrowser implements PlaywrightBrowserLike {
  public readonly context = new StorageStateContext();
  public closeCount = 0;

  public async newContext(): Promise<PlaywrightContextLike> {
    return this.context;
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }
}

export function storageStateSession(): {
  readonly session: PlaywrightBrowserSession;
  readonly context: StorageStateContext;
} {
  const browser = new StorageStateBrowser();
  const { context } = browser;
  return {
    session: new PlaywrightBrowserSession("chromium", browser, context, context.page),
    context,
  };
}
