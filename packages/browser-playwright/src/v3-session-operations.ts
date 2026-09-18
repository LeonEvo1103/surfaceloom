import type { BrowserAction, DomLocator as SurfaceDomLocator, SurfaceBackendCall } from "@surfaceloom/test";

import type { DomLocator } from "./contracts.js";
import { BrowserAutomationError, isBrowserAutomationError } from "./errors.js";
import { resolveDomLocator } from "./locator.js";
import type { PlaywrightLocatorLike, PlaywrightPageLike } from "./playwright-shapes.js";

export async function invokeSurfaceAction(
  page: PlaywrightPageLike,
  action: BrowserAction,
  call: SurfaceBackendCall,
  requireOpen: () => void,
): Promise<unknown> {
  requireOpen();
  if (action.kind === "navigate") {
    if (action.url.trim().length === 0) {
      throw new BrowserAutomationError("invalidArgument", "A navigation URL is required.");
    }
    const submission = call.beforeSubmit();
    try {
      const response = await page.goto(action.url, { timeout: submission.timeoutMs });
      return { url: page.url(), ...(response === null ? {} : { status: response.status() }) };
    } catch (error) { throw operationFailure("navigate", error); }
  }

  const locator = surfaceDomLocator(action.locator);
  const target = resolveDomLocator(page, locator);
  if (action.kind === "waitVisible") {
    const submission = call.beforeSubmit();
    try {
      await target.waitFor({ state: "visible", timeout: submission.timeoutMs });
      return undefined;
    } catch (error) { throw operationFailure("wait for target", error); }
  }

  await requireExactlyOne(target, locator.key, requireOpen);
  requireOpen();
  const submission = call.beforeSubmit();
  try {
    switch (action.kind) {
      case "click":
        await target.click({ timeout: submission.timeoutMs });
        return undefined;
      case "fill":
        await target.fill(action.value, { timeout: submission.timeoutMs });
        return undefined;
      case "readText":
        return (await target.textContent({ timeout: submission.timeoutMs })) ?? "";
    }
  } catch (error) { throw operationFailure(action.kind, error); }
}

async function requireExactlyOne(
  target: PlaywrightLocatorLike,
  key: string,
  requireOpen: () => void,
): Promise<void> {
  requireOpen();
  let count: number;
  try { count = await target.count(); }
  catch (error) { throw operationFailure("count targets", error); }
  if (count === 0) {
    throw new BrowserAutomationError("targetNotFound", `DOM target '${key}' was not found.`);
  }
  if (count !== 1) {
    throw new BrowserAutomationError(
      "ambiguousTarget",
      `DOM target '${key}' matched ${count} elements; exactly one is required.`,
    );
  }
}

function operationFailure(operation: string, error: unknown): BrowserAutomationError {
  if (isBrowserAutomationError(error)) return error;
  return new BrowserAutomationError("operationFailed", `The browser could not ${operation}.`, error);
}

function surfaceDomLocator(locator: SurfaceDomLocator): DomLocator {
  switch (locator.kind) {
    case "role": return { kind: "role", key: locator.key, role: locator.value };
    case "label": return { kind: "label", key: locator.key, text: locator.value, exact: true };
    case "text": return { kind: "text", key: locator.key, text: locator.value, exact: true };
    case "testId": return { kind: "testId", key: locator.key, value: locator.value };
    case "css": return { kind: "css", key: locator.key, selector: locator.value };
  }
}
