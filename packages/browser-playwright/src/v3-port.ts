import { randomUUID } from "node:crypto";

import type {
  BrowserAction,
  BrowserCloseProof,
  BrowserSurfaceBackendPort,
  BrowserSurfaceRequirement,
  BrowserSurfaceSessionPort,
  SurfaceBackendCall,
} from "@surfaceloom/test";

import type { PlaywrightLoader } from "./contracts.js";
import { BrowserAutomationError } from "./errors.js";
import { defaultPlaywrightLoader, launchOwnedBrowser } from "./owned-browser.js";
import type { PlaywrightBrowserSession } from "./session.js";

export const playwrightBrowserSurfaceCapabilities = Object.freeze([
  "browser.navigate",
  "browser.dom.inspect",
  "browser.dom.invoke",
] as const);

export interface PlaywrightBrowserSurfaceBackendOptions {
  readonly hostId?: string;
  readonly loader?: PlaywrightLoader;
  /** Optional owned-browser launch settings not represented by the v3 requirement. */
  readonly channel?: string;
  readonly executablePath?: string;
  readonly arguments?: readonly string[];
}

/** Runner options require a descriptor-only plain object; this is the preferred public constructor. */
export function createPlaywrightBrowserSurfaceBackend(
  options: PlaywrightBrowserSurfaceBackendOptions = {},
): BrowserSurfaceBackendPort {
  const implementation = new PlaywrightBrowserSurfaceBackend(options);
  return Object.freeze({
    hostId: implementation.hostId,
    capabilities: implementation.capabilities,
    launch: (requirement: BrowserSurfaceRequirement, call: SurfaceBackendCall) =>
      implementation.launch(requirement, call),
  });
}

/** Real Playwright implementation of the public v3 BrowserSurfaceBackendPort. */
export class PlaywrightBrowserSurfaceBackend implements BrowserSurfaceBackendPort {
  public readonly hostId: string;
  public readonly capabilities = playwrightBrowserSurfaceCapabilities;
  readonly #loader: PlaywrightLoader;
  readonly #launchOptions: Omit<PlaywrightBrowserSurfaceBackendOptions, "hostId" | "loader">;

  public constructor(options: PlaywrightBrowserSurfaceBackendOptions = {}) {
    this.hostId = stableId(options.hostId ?? "playwright.local", "Playwright hostId");
    this.#loader = options.loader ?? defaultPlaywrightLoader;
    this.#launchOptions = Object.freeze({
      ...(options.channel === undefined ? {} : { channel: options.channel }),
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      ...(options.arguments === undefined ? {} : { arguments: Object.freeze([...options.arguments]) }),
    });
  }

  public async launch(
    requirement: BrowserSurfaceRequirement,
    call: SurfaceBackendCall,
  ): Promise<BrowserSurfaceSessionPort> {
    const sessionId = `playwright-${randomUUID()}`;
    const session = await launchOwnedBrowser({
      engine: requirement.engine,
      headless: requirement.headless ?? true,
      ...this.#launchOptions,
    }, this.#loader, () => {
      // All module loading, option validation and identity preparation is complete.
      // Nothing asynchronous or fallible is inserted between this boundary and launch().
      const submission = call.beforeSubmit();
      return { timeout: submission.timeoutMs };
    }, call.signal);
    return new PlaywrightBrowserSurfaceSession(this.hostId, sessionId, session);
  }
}

class PlaywrightBrowserSurfaceSession implements BrowserSurfaceSessionPort {
  public readonly identity: Readonly<{ hostId: string; sessionId: string }>;
  #close: Promise<BrowserCloseProof> | undefined;

  public constructor(
    hostId: string,
    sessionId: string,
    private readonly session: PlaywrightBrowserSession,
  ) {
    this.identity = Object.freeze({ hostId, sessionId });
  }

  public invoke(action: BrowserAction, call: SurfaceBackendCall): Promise<unknown> {
    return this.session.invokeSurface(action, call);
  }

  public close(): Promise<BrowserCloseProof> {
    if (this.#close === undefined) this.#close = this.closeOnce();
    return this.#close;
  }

  private async closeOnce(): Promise<BrowserCloseProof> {
    await this.session.close();
    return Object.freeze({
      kind: "browserSessionClosed" as const,
      hostId: this.identity.hostId,
      sessionId: this.identity.sessionId,
    });
  }
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240
      || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u.test(value)) {
    throw new BrowserAutomationError("invalidArgument", `${label} must be a stable identifier.`);
  }
  return value;
}
