import type {
  BrowserArtifact,
  BrowserOperationOptions,
  BrowserStorageStateOptions,
} from "./contracts.js";
import { browserArtifact, captureArtifact, prepareArtifactPath, writeSensitiveArtifactFile } from "./artifact.js";
import { BrowserAutomationError } from "./errors.js";
import type { PlaywrightContextLike, PlaywrightPageLike } from "./playwright-shapes.js";
import type { RunOperation } from "./session-operations.js";

export class SessionArtifacts {
  private traceStarted = false;
  public constructor(
    private readonly page: PlaywrightPageLike,
    private readonly context: PlaywrightContextLike,
    private readonly run: RunOperation,
  ) {}

  public async screenshot(
    outputPath: string,
    fullPage = false,
    options: BrowserOperationOptions = {},
  ): Promise<BrowserArtifact> {
    const timeout = screenshotTimeout(options.timeoutMs);
    return captureArtifact("screenshot", "image/png", outputPath, async (target) => {
      await this.run("capture screenshot", () =>
        this.page.screenshot({ path: target, type: "png", fullPage, ...timeout })
      );
    });
  }

  public async startTrace(): Promise<void> {
    if (this.traceStarted) {
      throw new BrowserAutomationError("artifactState", "Browser tracing is already active.");
    }
    await this.run("start trace", () =>
      this.context.tracing.start({ screenshots: true, snapshots: true, sources: true })
    );
    this.traceStarted = true;
  }

  public async stopTrace(outputPath: string): Promise<BrowserArtifact> {
    if (!this.traceStarted) {
      throw new BrowserAutomationError("artifactState", "Browser tracing is not active.");
    }
    return captureArtifact("trace", "application/zip", outputPath, async (target) => {
      try {
        await this.run("stop trace", () => this.context.tracing.stop({ path: target }));
      } finally {
        this.traceStarted = false;
      }
    });
  }

  public async saveStorageState(
    outputPath: string,
    options: BrowserStorageStateOptions = {},
  ): Promise<BrowserArtifact> {
    const target = await prepareArtifactPath(outputPath, ".json");
    // No `path` is handed to Playwright: its writer truncates the destination
    // before it writes, so this package owns the write instead and lands the
    // snapshot atomically. The state object is returned either way.
    const state = await this.run("save storage state", () =>
      this.context.storageState({
        // Only an explicit opt-in reaches Playwright, so a caller that does not ask
        // for IndexedDB sends exactly the payload this package sent before the flag.
        ...(options.indexedDB === true ? { indexedDB: true } : {}),
      })
    );
    // Byte-compatible with what Playwright would have written, so exports stay
    // interchangeable with files produced by its own `path` option.
    await writeSensitiveArtifactFile(target, JSON.stringify(state, undefined, 2));
    return browserArtifact("storageState", target, "application/json");
  }

}

function screenshotTimeout(timeoutMs: number | undefined): { readonly timeout?: number } {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new BrowserAutomationError(
      "invalidArgument",
      "A screenshot timeout must be a positive finite number.",
    );
  }
  return timeoutMs === undefined ? {} : { timeout: timeoutMs };
}
