import type { BrowserOperationOptions, DomElementState, DomLocator } from "./contracts.js";
import { BrowserAutomationError } from "./errors.js";
import { resolveDomLocator } from "./locator.js";
import type { PlaywrightPageLike } from "./playwright-shapes.js";
import { timeoutOptions, type RunOperation } from "./session-operations.js";

/** Read one resolved node; visibility/enabled are sequential, not an atomic DOM snapshot.
 * This covers presence/visibility/enablement, not stability or hit-target occlusion.
 */
export async function readElementState(
  page: PlaywrightPageLike,
  locator: DomLocator,
  options: BrowserOperationOptions,
  run: RunOperation,
): Promise<DomElementState> {
  const timeout = timeoutOptions(options.timeoutMs);
  const target = resolveDomLocator(page, locator);
  try {
    await target.first().waitFor({ state: "attached", ...timeout });
  } catch {
    // Absence is an observation here, not an error; the count below decides.
  }
  const count = await run("count targets", () => target.count());
  if (count === 0) {
    return { present: false, visible: false, enabled: false, clickable: false };
  }
  if (count !== 1) {
    throw new BrowserAutomationError(
      "ambiguousTarget",
      `DOM target '${locator.key}' matched ${count} elements; exactly one is required.`,
    );
  }
  const handle = await run("resolve the target element", () =>
    target.elementHandle(timeout)
  );
  if (handle === null) {
    return { present: false, visible: false, enabled: false, clickable: false };
  }
  try {
    const visible = await run("read target visibility", () =>
      handle.isVisible()
    );
    const enabled = await run("read target enablement", () =>
      handle.isEnabled()
    );
    return { present: true, visible, enabled, clickable: visible && enabled };
  } finally {
    try {
      await handle.dispose();
    } catch {
      // A handle that will not be released is page-scoped bookkeeping; it
      // cannot change the observation already taken, and promoting it to an
      // error would report a product fault that is not there.
    }
  }
}
