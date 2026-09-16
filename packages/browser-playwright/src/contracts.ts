export const browserEngines = ["chromium", "firefox", "webkit"] as const;

export type BrowserEngine = (typeof browserEngines)[number];

export const browserCapabilities = [
  "browser.navigate",
  "browser.dom.inspect",
  "browser.dom.invoke",
  "browser.trace",
  "browser.network.proxy",
  "screenshot.capture",
] as const;

export type BrowserCapability = (typeof browserCapabilities)[number];

export interface BrowserViewport {
  readonly width: number;
  readonly height: number;
}

export interface BrowserProxyOptions {
  /** http://host:port, https://host:port or socks5://host:port. Credentials never go here. */
  readonly server: string;
  readonly bypass?: string;
  readonly username?: string;
  readonly password?: string;
}

export interface BrowserContextOptions {
  readonly baseURL?: string;
  readonly locale?: string;
  readonly viewport?: BrowserViewport;
  readonly ignoreHTTPSErrors?: boolean;
  readonly acceptDownloads?: boolean;
  readonly storageStatePath?: string;
  readonly proxy?: BrowserProxyOptions;
}

export interface BrowserLaunchOptions {
  readonly engine?: BrowserEngine;
  readonly headless?: boolean;
  readonly channel?: string;
  readonly executablePath?: string;
  readonly arguments?: readonly string[];
  readonly context?: BrowserContextOptions;
}

export interface BrowserOperationOptions {
  readonly timeoutMs?: number;
}

export type BrowserWaitUntil =
  | "commit"
  | "domcontentloaded"
  | "load"
  | "networkidle";

export interface BrowserNavigateOptions extends BrowserOperationOptions {
  readonly waitUntil?: BrowserWaitUntil;
}

export type DomWaitState = "attached" | "detached" | "visible" | "hidden";

interface DomLocatorBase {
  /** Stable product-owned key used for diagnostics without exposing selector data. */
  readonly key: string;
}

export type DomLocator = DomLocatorBase & (
  | {
      readonly kind: "role";
      readonly role: string;
      readonly name?: string;
      readonly exact?: boolean;
    }
  | {
      readonly kind: "label";
      readonly text: string;
      readonly exact?: boolean;
    }
  | {
      readonly kind: "text";
      readonly text: string;
      readonly exact?: boolean;
    }
  | {
      readonly kind: "testId";
      readonly value: string;
    }
  | {
      /** Product-adapter escape hatch; prefer role, label, text, or testId. */
      readonly kind: "css";
      readonly selector: string;
    }
);

export interface BrowserNavigationResult {
  readonly url: string;
  readonly status?: number;
}

export interface BrowserArtifact {
  readonly kind: "screenshot" | "trace";
  readonly sourcePath: string;
  readonly contentType: "image/png" | "application/zip";
  readonly capturedAt: string;
  /** Browser evidence can contain credentials, page content, or user data. */
  readonly sensitive: true;
}

export interface BrowserSession {
  readonly engine: BrowserEngine;
  readonly isClosed: boolean;

  navigate(url: string, options?: BrowserNavigateOptions): Promise<BrowserNavigationResult>;
  click(locator: DomLocator, options?: BrowserOperationOptions): Promise<void>;
  fill(locator: DomLocator, value: string, options?: BrowserOperationOptions): Promise<void>;
  text(locator: DomLocator, options?: BrowserOperationOptions): Promise<string>;
  waitFor(
    locator: DomLocator,
    state: DomWaitState,
    options?: BrowserOperationOptions,
  ): Promise<void>;
  title(): Promise<string>;
  currentURL(): string;
  screenshot(outputPath: string, fullPage?: boolean): Promise<BrowserArtifact>;
  startTrace(): Promise<void>;
  stopTrace(outputPath: string): Promise<BrowserArtifact>;
  close(): Promise<void>;
}

export interface BrowserBackend {
  readonly capabilities: readonly BrowserCapability[];
  launch(options?: BrowserLaunchOptions): Promise<BrowserSession>;
}

/** Injection seam for tests and alternative Playwright distributions. */
export type PlaywrightLoader = () => Promise<unknown>;
