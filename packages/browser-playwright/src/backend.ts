import {
  browserCapabilities,
  type BrowserBackend,
  type BrowserLaunchOptions,
  type BrowserSession,
  type PlaywrightLoader,
} from "./contracts.js";
import { defaultPlaywrightLoader, launchOwnedBrowser } from "./owned-browser.js";

export class PlaywrightBrowserBackend implements BrowserBackend {
  public readonly capabilities = browserCapabilities;

  public constructor(
    private readonly loader: PlaywrightLoader = defaultPlaywrightLoader,
  ) {}

  public async launch(
    options: BrowserLaunchOptions = {},
  ): Promise<BrowserSession> {
    return launchOwnedBrowser(options, this.loader);
  }
}
