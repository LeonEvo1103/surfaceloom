import {
  BrowserAcquisitionController,
  snapshotBrowserCleanupStop,
  type BrowserCleanupStop,
} from "./browser-controller.js";
import { SurfaceCallContext } from "./call-context.js";
import type {
  BrowserAction,
  BrowserSurfaceAuthor,
  BrowserSurfaceBackendPort,
  BrowserSurfaceRequirement,
  BrowserSurfaceSessionPort,
  SurfaceLease,
  SurfaceSetupContext,
} from "./contracts.js";
import { browserActionEffect, browserLaunchEffect } from "./effects.js";
import { SurfaceProviderError } from "./errors.js";
import { effectiveCapabilities, stableId } from "./validation.js";

export interface BrowserSurfaceFactory {
  setup(requirement: BrowserSurfaceRequirement,
    context: SurfaceSetupContext): Promise<BrowserSurfaceAuthor>;
}

export interface BrowserSurfaceFactoryOptions {
  readonly lease?: SurfaceLease;
  /** Must be no greater than the owning ResourceScope cleanup budget. */
  readonly cleanupTimeoutMs?: number;
  /** Required with a lease; abort when the outer cleanup scope stops or times out. */
  readonly cleanupStop?: BrowserCleanupStop;
}

/** The optional backend is a required constructor argument and is never dynamically imported. */
export function createBrowserSurfaceFactory(
  backend: BrowserSurfaceBackendPort,
  options: BrowserSurfaceFactoryOptions = {},
): BrowserSurfaceFactory {
  return Object.freeze({
    setup: (requirement: BrowserSurfaceRequirement, context: SurfaceSetupContext) =>
      setupBrowser(backend, options, requirement, context),
  });
}

async function setupBrowser(
  backend: BrowserSurfaceBackendPort,
  options: BrowserSurfaceFactoryOptions,
  requirement: BrowserSurfaceRequirement,
  context: SurfaceSetupContext,
): Promise<BrowserSurfaceAuthor> {
  exactRequirement(requirement);
  const surfaceId = stableId("surfaceId", requirement.surfaceId);
  const expectedHostId = stableId("expectedHostId", requirement.expectedHostId);
  const actualHostId = stableId("backend hostId", backend.hostId);
  if (expectedHostId !== actualHostId) {
    throw new SurfaceProviderError("hostMismatch", "Browser backend host does not match the requirement.");
  }
  const capabilities = effectiveCapabilities(requirement.capabilities, backend.capabilities);
  const call = new SurfaceCallContext(context, requirement.timeoutMs);
  const cleanupTimeoutMs = positiveTimeout(options.cleanupTimeoutMs ?? 1_000);
  const cleanupStop = validateCleanupStop(options.cleanupStop, options.lease !== undefined);
  const controller = new BrowserAcquisitionController(surfaceId, context.evidence, cleanupTimeoutMs,
    cleanupStop);
  let pending: Promise<BrowserSurfaceSessionPort>;
  try {
    registerResources(context, controller, surfaceId, options.lease);
    pending = context.dispatch(browserLaunchEffect, () => backend.launch(requirement, call));
  } catch (error) {
    call.dispose();
    throw error;
  }
  controller.watch(pending, call);
  const session = await call.wait(pending);
  if (session.identity.hostId !== actualHostId || stableId("browser sessionId",
    session.identity.sessionId) !== session.identity.sessionId) {
    throw new SurfaceProviderError("invalidBackendReceipt", "Browser session identity is invalid.");
  }
  context.evidence.submit({ kind: "acquired", surfaceId, outcome: "succeeded" });
  return Object.freeze({
    kind: "browser",
    surfaceId,
    capabilities,
    perform: (action: BrowserAction, operationOptions: { readonly timeoutMs?: number } = {}) =>
      performBrowser(session.invoke.bind(session), action, operationOptions.timeoutMs, surfaceId, context),
  });
}

function positiveTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new SurfaceProviderError("invalidRequest", "Browser cleanup timeout is invalid.");
  }
  return Math.floor(value);
}

function validateCleanupStop(value: BrowserCleanupStop | undefined,
  required: boolean): BrowserCleanupStop | undefined {
  try { return snapshotBrowserCleanupStop(value, required); }
  catch (error) {
    throw new SurfaceProviderError("invalidRequest", "Browser cleanup stop contract is invalid.",
      { cause: error });
  }
}

async function performBrowser(
  invoke: BrowserSurfaceSessionPort["invoke"],
  action: BrowserAction,
  timeoutMs: number | undefined,
  surfaceId: string,
  context: SurfaceSetupContext,
): Promise<unknown> {
  validateBrowserAction(action);
  const call = new SurfaceCallContext(context, timeoutMs);
  let pending: Promise<unknown>;
  try { pending = context.dispatch(browserActionEffect(action), () => invoke(action, call)); }
  catch (error) { call.dispose(); throw error; }
  try {
    const result = await call.wait(pending);
    context.evidence.submit({ kind: "operation", surfaceId, operation: action.kind,
      outcome: "succeeded" });
    return result;
  } catch (error) {
    try {
      context.evidence.submit({ kind: "operation", surfaceId, operation: action.kind,
        outcome: error instanceof SurfaceProviderError && error.code === "unknownOutcome"
          ? "unknown" : "failed" });
    } catch { /* required-evidence validation records the missing diagnostic additively */ }
    throw error;
  }
}

function registerResources(
  context: SurfaceSetupContext,
  controller: BrowserAcquisitionController,
  surfaceId: string,
  lease: SurfaceLease | undefined,
): void {
  if (lease !== undefined) {
    const leaseId = stableId("lease id", lease.id);
    context.registerResource({ id: `surface.browser.lease.${leaseId}`, ownership: "owned",
      cleanup: async () => {
        const prior = await controller.cleanup();
        if (prior.status !== "released" || !controller.leaseReleaseAllowed()) {
          return prior.status === "released"
            ? { status: "unconfirmed", reason: "Browser cleanup boundary stopped before lease release." }
            : prior;
        }
        const receipt = await lease.release();
        return receipt?.status === "released" ? receipt
          : { status: "unconfirmed", reason: "Browser lease release was not confirmed." };
      } });
  }
  context.registerResource({ id: `surface.browser.session.${surfaceId}`, ownership: "owned",
    cleanup: () => controller.cleanup() });
}

function validateBrowserAction(action: BrowserAction): void {
  if (!["navigate", "click", "fill", "readText", "waitVisible"].includes(action.kind)) {
    throw new SurfaceProviderError("invalidRequest", "Unknown browser action.");
  }
  if (action.kind === "navigate") {
    if (typeof action.url !== "string" || action.url.length === 0) {
      throw new SurfaceProviderError("invalidRequest", "Browser navigation requires a URL.");
    }
    return;
  }
  if (action.locator.kind !== "role" && action.locator.kind !== "label"
      && action.locator.kind !== "text" && action.locator.kind !== "testId"
      && action.locator.kind !== "css") {
    throw new SurfaceProviderError("invalidRequest", "Unknown DOM locator kind.");
  }
  stableId("DOM locator key", action.locator.key);
  if (typeof action.locator.value !== "string" || action.locator.value.length === 0) {
    throw new SurfaceProviderError("invalidRequest", "DOM locator value is required.");
  }
}

function exactRequirement(requirement: BrowserSurfaceRequirement): void {
  if (typeof requirement !== "object" || requirement === null
      || Object.keys(requirement).some((key) => !["kind", "surfaceId", "expectedHostId",
        "capabilities", "engine", "headless", "timeoutMs"].includes(key))) {
    throw new SurfaceProviderError("invalidRequest", "Browser requirement contains unknown fields.");
  }
  if (requirement.kind !== "browser"
      || !["chromium", "firefox", "webkit"].includes(requirement.engine)
      || (requirement.headless !== undefined && typeof requirement.headless !== "boolean")) {
    throw new SurfaceProviderError("invalidRequest", "Browser requirement is invalid.");
  }
}
