import type { PlaywrightBrowserLike, PlaywrightContextLike } from "./playwright-shapes.js";

const failedAcquisitionCloseTimeoutMs = 1_000;

/** Closes each handle independently, including handles that arrive after stop. */
export class OwnedBrowserAcquisitionCleanup {
  #browser: PlaywrightBrowserLike | undefined;
  #context: PlaywrightContextLike | undefined;
  #browserClose: Promise<void> | undefined;
  #contextClose: Promise<void> | undefined;
  #stopped = false;

  setBrowser(browser: PlaywrightBrowserLike): void {
    this.#browser = browser;
    if (this.#stopped) this.startBrowserClose();
  }

  setContext(context: PlaywrightContextLike): void {
    this.#context = context;
    if (this.#stopped) this.startContextClose();
  }

  stop(): void {
    this.#stopped = true;
    this.startContextClose();
    this.startBrowserClose();
  }

  async settle(): Promise<void> {
    this.stop();
    await Promise.all([
      this.#contextClose ?? Promise.resolve(),
      this.#browserClose ?? Promise.resolve(),
    ]);
  }

  private startContextClose(): void {
    if (this.#contextClose === undefined && this.#context !== undefined) {
      this.#contextClose = boundedBestEffort(() => this.#context!.close());
    }
  }

  private startBrowserClose(): void {
    if (this.#browserClose === undefined && this.#browser !== undefined) {
      this.#browserClose = boundedBestEffort(() => this.#browser!.close());
    }
  }
}

async function boundedBestEffort(close: () => Promise<void>): Promise<void> {
  let pending: Promise<void>;
  try { pending = Promise.resolve(close()); }
  catch { return; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, failedAcquisitionCloseTimeoutMs);
  });
  try { await Promise.race([pending.catch(() => undefined), timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
