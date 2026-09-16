import type { BrowserNavigateOptions } from "./contracts.js";
import { BrowserAutomationError } from "./errors.js";

export type RunOperation = <T>(operation: string, action: () => Promise<T>) => Promise<T>;

export function timeoutOptions(timeoutMs: number | undefined): { readonly timeout?: number } {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new BrowserAutomationError(
      "invalidArgument",
      "A browser operation timeout must be a non-negative finite number.",
    );
  }
  return timeoutMs === undefined ? {} : { timeout: timeoutMs };
}

export function operationOptions(
  options: BrowserNavigateOptions,
): { readonly timeout?: number; readonly waitUntil?: string } {
  return {
    ...timeoutOptions(options.timeoutMs),
    ...(options.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
  };
}
