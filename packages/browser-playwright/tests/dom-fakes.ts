import type { PlaywrightElementHandleLike, PlaywrightLocatorLike } from "../src/playwright-shapes.js";

/**
 * One pinned DOM node: the values it reports are fixed at the moment the
 * handle was taken, which is the whole difference between a handle and a
 * locator and the reason the session pins one before reading a pair.
 */
export class FakeElementHandle implements PlaywrightElementHandleLike {
  public disposed = false;

  public constructor(
    private readonly pinnedVisible: boolean,
    private readonly pinnedEnabled: boolean,
  ) {}

  public async isVisible(): Promise<boolean> {
    return this.pinnedVisible;
  }

  public async isEnabled(): Promise<boolean> {
    return this.pinnedEnabled;
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
  }
}

export class FakeLocator implements PlaywrightLocatorLike {
  public matches = 1;
  public visible = true;
  public enabled = true;
  public content: string | null = "fixture text";
  public waitFailure: unknown;
  public readonly calls: string[] = [];
  /**
   * The page moving on under the locator. A real Playwright locator re-runs
   * its query on every call, so each entry here is applied before one further
   * resolution -- which is how a test can tell "read once through a pinned
   * node" apart from "read twice through a locator".
   */
  public readonly domChanges: Array<
    Partial<{ matches: number; visible: boolean; enabled: boolean }>
  > = [];
  /** Handles handed out, so a test can assert they were released. */
  public readonly handles: FakeElementHandle[] = [];

  private applyNextResolution(): void {
    const next = this.domChanges.shift();
    if (next === undefined) return;
    if (next.matches !== undefined) this.matches = next.matches;
    if (next.visible !== undefined) this.visible = next.visible;
    if (next.enabled !== undefined) this.enabled = next.enabled;
  }

  public first(): FakeLocator {
    this.calls.push("first");
    return this;
  }

  public async count(): Promise<number> {
    this.applyNextResolution();
    this.calls.push("count");
    return this.matches;
  }

  public async elementHandle(): Promise<FakeElementHandle | null> {
    this.applyNextResolution();
    this.calls.push("elementHandle");
    if (this.matches === 0) return null;
    const handle = new FakeElementHandle(this.visible, this.enabled);
    this.handles.push(handle);
    return handle;
  }

  public async waitFor(options: { readonly state: string }): Promise<void> {
    this.calls.push(`wait:${options.state}`);
    if (this.waitFailure !== undefined) throw this.waitFailure;
    if (this.matches === 0 && (options.state === "attached" || options.state === "visible")) {
      throw new Error("locator.waitFor: Timeout exceeded.");
    }
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

  public async isVisible(): Promise<boolean> {
    this.applyNextResolution();
    this.calls.push("isVisible");
    return this.visible;
  }

  public async isEnabled(): Promise<boolean> {
    this.applyNextResolution();
    this.calls.push("isEnabled");
    return this.enabled;
  }
}
