import {
  createPlaywrightBrowserRunOptions,
  type PlaywrightBrowserRunOptionsInput,
} from "@surfaceloom/browser-playwright/v3";
import type { EffectDescriptor, ExecutionEffectPolicy, RunCaseV3Options } from "@surfaceloom/test";

declare const effects: readonly EffectDescriptor[];
declare const policy: ExecutionEffectPolicy;
declare const input: Omit<PlaywrightBrowserRunOptionsInput, "effects" | "policy">;

export const options: RunCaseV3Options = createPlaywrightBrowserRunOptions({
  ...input,
  effects,
  policy,
  browser: { engine: "chromium", channel: "chrome", timeoutMs: 10_000 },
  budgets: { executionTimeoutMs: 20_000, cleanupTimeoutMs: 5_000 },
});
