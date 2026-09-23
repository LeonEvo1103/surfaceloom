import type { BrowserObservationHandle, BrowserObservationOptions } from "./observation-contracts.js";
export * from "./observation-contracts.js";

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

/** One resolved node's readiness. Reads are sequential, not an atomic DOM snapshot.
 * Missing targets return present:false; ambiguous targets and automation errors throw.
 * Clickable covers presence, visibility and enablement, not stability or occlusion.
 */
export interface DomElementState {
  /** Exactly one matching element is attached to the DOM. */
  readonly present: boolean;
  /** The element is attached and not hidden. False whenever `present` is false. */
  readonly visible: boolean;
  /** The element is attached and not disabled. False whenever `present` is false. */
  readonly enabled: boolean;
  /** `present && visible && enabled`. */
  readonly clickable: boolean;
}

export interface BrowserArtifact {
  readonly kind: "screenshot" | "trace" | "storageState";
  readonly sourcePath: string;
  readonly contentType: "image/png" | "application/zip" | "application/json";
  readonly capturedAt: string;
  /** Browser evidence can contain credentials, page content, or user data. */
  readonly sensitive: true;
}

export interface BrowserStorageStateOptions {
  /**
   * Includes IndexedDB in the export, which some sites use to hold their session
   * tokens. Defaults to `false` because IndexedDB is also a general-purpose local
   * cache: enabling it unconditionally would pull an unbounded amount of site data
   * into a file that is already credential-equivalent, widening the exposure this
   * package deliberately minimises. Turn it on only for products whose login
   * actually lives there.
   */
  readonly indexedDB?: boolean;
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
  /**
   * Reports whether a target is currently interactable. Returns an absent
   * snapshot instead of throwing when the target never attaches within the
   * timeout; still throws `ambiguousTarget` when the locator matches more than
   * one element, because an ambiguous probe is a checker defect rather than an
   * observation about the product.
   */
  elementState(
    locator: DomLocator,
    options?: BrowserOperationOptions,
  ): Promise<DomElementState>;
  title(): Promise<string>;
  currentURL(): string;
  screenshot(
    outputPath: string,
    fullPage?: boolean,
    options?: BrowserOperationOptions,
  ): Promise<BrowserArtifact>;
  /**
   * Exports the live cookies and origin localStorage so one real login can seed
   * later sessions through `BrowserContextOptions.storageStatePath`. sessionStorage
   * is never included because Playwright has no API to persist it. IndexedDB is
   * opt-in through `options.indexedDB`; see `BrowserStorageStateOptions`.
   */
  saveStorageState(
    outputPath: string,
    options?: BrowserStorageStateOptions,
  ): Promise<BrowserArtifact>;
  startTrace(): Promise<void>;
  stopTrace(outputPath: string): Promise<BrowserArtifact>;
  observe(options?: BrowserObservationOptions): BrowserObservationHandle;
  close(): Promise<void>;
}

export interface BrowserBackend {
  readonly capabilities: readonly BrowserCapability[];
  launch(options?: BrowserLaunchOptions): Promise<BrowserSession>;
}

/** Injection seam for tests and alternative Playwright distributions. */
export type PlaywrightLoader = () => Promise<unknown>;
