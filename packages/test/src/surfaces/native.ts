import type { DesktopPlatform } from "@surfaceloom/core";

import { SurfaceCallContext } from "./call-context.js";
import type {
  NativeAction,
  NativeSurfaceAuthor,
  NativeSurfaceBackendPort,
  NativeSurfaceRequirement,
  NativeSurfaceSessionPort,
  SurfaceOwnership,
  SurfaceSetupContext,
} from "./contracts.js";
import { SurfaceProviderError } from "./errors.js";
import { effectiveCapabilities, stableId } from "./validation.js";

export interface NativeSurfaceFactory<P extends DesktopPlatform> {
  setup<O extends SurfaceOwnership>(requirement: NativeSurfaceRequirement<P, O>,
    context: SurfaceSetupContext): Promise<NativeSurfaceAuthor<P, O>>;
}

/** Inject an adapter around acquireNativeApplication; no native runtime is imported here. */
export function createNativeSurfaceFactory<P extends DesktopPlatform>(
  port: NativeSurfaceBackendPort<P>,
): NativeSurfaceFactory<P> {
  return Object.freeze({
    setup: <O extends SurfaceOwnership>(requirement: NativeSurfaceRequirement<P, O>,
      context: SurfaceSetupContext) => setupNative(port, requirement, context),
  });
}

async function setupNative<P extends DesktopPlatform, O extends SurfaceOwnership>(
  port: NativeSurfaceBackendPort<P>,
  requirement: NativeSurfaceRequirement<P, O>,
  context: SurfaceSetupContext,
): Promise<NativeSurfaceAuthor<P, O>> {
  exactRequirement(requirement);
  const surfaceId = stableId("surfaceId", requirement.surfaceId);
  if (stableId("expectedHostId", requirement.expectedHostId) !== stableId("native hostId", port.hostId)) {
    throw new SurfaceProviderError("hostMismatch", "Native backend host does not match the requirement.");
  }
  if (requirement.platform !== port.platform || requirement.backend !== port.backend) {
    throw new SurfaceProviderError("platformMismatch", "Native backend platform does not match the requirement.");
  }
  const declared = effectiveCapabilities(requirement.capabilities, port.capabilities);
  const call = new SurfaceCallContext(context, requirement.timeoutMs);
  // prepare is synchronous by contract so lifecycle and late-acquisition resources exist first.
  let pending: Promise<NativeSurfaceSessionPort<P, O>>;
  try {
    const prepared = port.prepare(requirement, context);
    pending = prepared.acquire(call);
  } catch (error) {
    call.dispose();
    throw error;
  }
  const session = await call.wait(pending);
  const expectedOwnership = requirement.acquisition === "launch" ? "owned" : "borrowed";
  const ownership = session.ownership;
  if (ownership !== expectedOwnership) {
    throw new SurfaceProviderError("wrongOwnership", "Native backend returned the wrong ownership.");
  }
  if (session.platform !== requirement.platform || session.backend !== requirement.backend) {
    throw new SurfaceProviderError("platformMismatch", "Native session platform does not match the requirement.");
  }
  const capabilities = effectiveCapabilities(declared, session.capabilities);
  context.evidence.submit({ kind: "acquired", surfaceId, outcome: "succeeded" });
  return authorFacade(surfaceId, capabilities, ownership, session, context);
}

function authorFacade<P extends DesktopPlatform, O extends SurfaceOwnership>(
  surfaceId: string,
  capabilities: readonly string[],
  ownership: O,
  session: NativeSurfaceSessionPort<P, O>,
  context: SurfaceSetupContext,
): NativeSurfaceAuthor<P, O> {
  return Object.freeze({
    kind: "native",
    surfaceId,
    platform: session.platform,
    backend: session.backend,
    ownership,
    capabilities,
    perform: (action: NativeAction<P, O>, options: { readonly timeoutMs?: number } = {}) =>
      performNative(session, ownership, action, options.timeoutMs, surfaceId, context),
  });
}

async function performNative<P extends DesktopPlatform, O extends SurfaceOwnership>(
  session: NativeSurfaceSessionPort<P, O>,
  ownership: O,
  action: NativeAction<P, O>,
  timeoutMs: number | undefined,
  surfaceId: string,
  context: SurfaceSetupContext,
): Promise<unknown> {
  validateNativeAction(session, ownership, action);
  const call = new SurfaceCallContext(context, timeoutMs);
  let pending: Promise<unknown>;
  try { pending = session.invoke(action, context, call); }
  catch (error) { call.dispose(); throw error; }
  try {
    const result = await call.wait(pending);
    context.evidence.submit({ kind: "operation", surfaceId, operation: action.kind,
      outcome: "succeeded" });
    return result;
  } catch (error) {
    try {
      context.evidence.submit({ kind: "operation", surfaceId, operation: action.kind,
        outcome: unknownOperationOutcome(error)
          ? "unknown" : "failed" });
    } catch { /* required-evidence validation records the missing diagnostic additively */ }
    throw error;
  }
}

function validateNativeAction<P extends DesktopPlatform, O extends SurfaceOwnership>(
  session: NativeSurfaceSessionPort<P, O>, ownership: O, action: NativeAction<P, O>,
): void {
  if ((action.kind === "quit" || action.kind === "terminate")) {
    if (ownership !== "owned") {
      throw new SurfaceProviderError("wrongOwnership", "Borrowed native surfaces have no lifecycle actions.");
    }
    return;
  }
  if (!["find", "invoke", "setValue"].includes(action.kind)) {
    throw new SurfaceProviderError("invalidRequest", "Unknown native action.");
  }
  if ((session.platform === "macos" && action.locator.backend !== "ax")
      || (session.platform === "windows" && action.locator.backend !== "uia")) {
    throw new SurfaceProviderError("platformMismatch", "Native locator backend does not match the surface.");
  }
}

function unknownOperationOutcome(error: unknown): boolean {
  if (error instanceof SurfaceProviderError && error.code === "unknownOutcome") return true;
  if (typeof error !== "object" || error === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "operationOutcome");
  return descriptor !== undefined && "value" in descriptor && descriptor.value === "unknown";
}

function exactRequirement<P extends DesktopPlatform, O extends SurfaceOwnership>(
  requirement: NativeSurfaceRequirement<P, O>,
): void {
  if (typeof requirement !== "object" || requirement === null
      || Object.keys(requirement).some((key) => !["kind", "surfaceId", "expectedHostId",
        "platform", "backend", "acquisition", "capabilities", "target", "timeoutMs"].includes(key))) {
    throw new SurfaceProviderError("invalidRequest", "Native requirement contains unknown fields.");
  }
  if (requirement.kind !== "native"
      || (requirement.acquisition !== "launch" && requirement.acquisition !== "attach")) {
    throw new SurfaceProviderError("invalidRequest", "Native requirement is invalid.");
  }
  stableId("native target", requirement.target);
}
