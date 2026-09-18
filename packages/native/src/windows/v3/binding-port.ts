import type {
  NativeAcquisitionKind, NativeBindingCallOptions, NativeBindingPort, NativeCleanupProof,
  NativeOperationContract, NativeOperationResult, NativeSessionIdentity,
} from "@surfaceloom/test";

import type { WindowsAttachOptions, WindowsLaunchOptions, WindowsUiaLocator } from "../contracts.js";
import { WindowsNativeController } from "../controller.js";
import { WindowsNativeError } from "../error.js";
import type { WindowsDesktopSession } from "../desktop-session.js";
import { strictLocator } from "../validation.js";

export type WindowsBindingTarget = Readonly<{ readonly kind: "launch"; readonly options: WindowsLaunchOptions }>
  | Readonly<{ readonly kind: "attach"; readonly options: WindowsAttachOptions }>;

/** Maps the Windows v1 controller onto the existing runner-owned cleanup binding. */
export class WindowsV3BindingPort implements NativeBindingPort {
  readonly #sessions = new Map<string, WindowsDesktopSession<"owned"> | WindowsDesktopSession<"borrowed">>();
  constructor(readonly controller: WindowsNativeController, readonly target: WindowsBindingTarget,
    readonly acquisitionBoundary?: () => NativeBindingCallOptions) {}

  async acquire(kind: NativeAcquisitionKind,
    options: NativeBindingCallOptions): Promise<NativeOperationResult<NativeSessionIdentity>> {
    if (kind !== this.target.kind) throw new WindowsNativeError("invalidPayload", "Acquisition kind changed after prepare.");
    const submitted = this.acquisitionBoundary?.() ?? options;
    const effective = Object.freeze({ timeoutMs: Math.min(options.timeoutMs, submitted.timeoutMs),
      ...(submitted.signal === undefined ? {} : { signal: submitted.signal }) });
    let session: WindowsDesktopSession<"owned"> | WindowsDesktopSession<"borrowed">;
    if (this.target.kind === "launch") {
      session = await this.controller.launch({ ...this.target.options, ...effective });
    } else {
      session = await this.controller.attach({ ...this.target.options, ...effective });
    }
    this.#sessions.set(session.descriptor.sessionId, session);
    return Object.freeze({ value: identity(session), operation: session.acquisitionReceipt });
  }

  async invokeSurface<T>(identity: NativeSessionIdentity, contract: NativeOperationContract,
    payload: Readonly<Record<string, unknown>>, overall: NativeBindingCallOptions,
    beforeSubmit: () => NativeBindingCallOptions): Promise<NativeOperationResult<T>> {
    const session = this.session(identity);
    switch (contract.method) {
      case "element.find": return await session.find(payloadLocator(payload), beforeSubmit()) as NativeOperationResult<T>;
      case "element.action": {
        const locator = payloadLocator(payload);
        const result = contract.action === "invoke"
          ? await session.invokeAtSubmission(locator, overall, beforeSubmit)
          : await session.setValueAtSubmission(locator, stringPayload(payload, "value"), overall, beforeSubmit);
        return result as NativeOperationResult<T>;
      }
      case "session.close": {
        if (session.ownership !== "owned") throw new WindowsNativeError("wrongOwnership", "Close requires ownership.");
        return await session.lifecyclePort.quit(beforeSubmit()) as NativeOperationResult<T>;
      }
      case "session.terminate": {
        if (session.ownership !== "owned") throw new WindowsNativeError("wrongOwnership", "Terminate requires ownership.");
        return await session.lifecyclePort.terminate(beforeSubmit()) as NativeOperationResult<T>;
      }
      default: throw new WindowsNativeError("capabilityMismatch", `Unsupported Windows method '${contract.method}'.`);
    }
  }

  async reconcileLateAcquisition(options: NativeBindingCallOptions): Promise<NativeSessionIdentity | null> {
    const session = this.target.kind === "launch"
      ? await this.controller.reconcileLate("launch", options.timeoutMs)
      : await this.controller.reconcileLate("attach", options.timeoutMs);
    if (session === null) return null;
    this.#sessions.set(session.descriptor.sessionId, session);
    return identity(session);
  }

  async invoke<T>(identity: NativeSessionIdentity, contract: NativeOperationContract,
    payload: Readonly<Record<string, unknown>>, options: NativeBindingCallOptions):
  Promise<NativeOperationResult<T>> {
    const session = this.session(identity);
    switch (contract.method) {
      case "element.find": {
        const result = await session.find(payloadLocator(payload), options);
        return result as NativeOperationResult<T>;
      }
      case "element.action": {
        const locator = payloadLocator(payload);
        const result = contract.action === "invoke"
          ? await session.invoke(locator, options)
          : await session.setValue(locator, stringPayload(payload, "value"), options);
        return result as NativeOperationResult<T>;
      }
      case "session.close": {
        if (session.ownership !== "owned") throw new WindowsNativeError("wrongOwnership", "Close requires ownership.");
        return await session.lifecyclePort.quit(options) as NativeOperationResult<T>;
      }
      case "session.terminate": {
        if (session.ownership !== "owned") throw new WindowsNativeError("wrongOwnership", "Terminate requires ownership.");
        return await session.lifecyclePort.terminate(options) as NativeOperationResult<T>;
      }
      default: throw new WindowsNativeError("capabilityMismatch", `Unsupported Windows method '${contract.method}'.`);
    }
  }

  cleanupTarget(identity: NativeSessionIdentity): Promise<NativeCleanupProof> {
    const session = this.session(identity);
    if (session.ownership !== "owned") return Promise.reject(
      new WindowsNativeError("wrongOwnership", "Borrowed targets are not ended."));
    return session.cleanupPort.targetExit();
  }

  releaseProtocol(identity: NativeSessionIdentity): Promise<NativeCleanupProof> {
    return this.session(identity).cleanupPort.release();
  }

  closeHost(): Promise<NativeCleanupProof> { return this.controller.closeHostProof(); }

  private session(identity: NativeSessionIdentity): WindowsDesktopSession<"owned"> | WindowsDesktopSession<"borrowed"> {
    const session = this.#sessions.get(identity.sessionId);
    if (session === undefined || session.descriptor.hostInstanceId !== identity.hostInstanceId) {
      throw new WindowsNativeError("staleHandle", "Windows binding received a foreign session identity.");
    }
    return session;
  }
}

function identity(session: WindowsDesktopSession<"owned"> | WindowsDesktopSession<"borrowed">): NativeSessionIdentity {
  return Object.freeze({ hostInstanceId: session.descriptor.hostInstanceId,
    sessionId: session.descriptor.sessionId, handleId: session.descriptor.root.handleId,
    targetIdentity: session.targetIdentity, ownership: session.ownership,
    surface: session.descriptor.surface });
}

function payloadLocator(payload: Readonly<Record<string, unknown>>): WindowsUiaLocator {
  return strictLocator(payload.locator as WindowsUiaLocator);
}

function stringPayload(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.includes("\0")) {
    throw new WindowsNativeError("invalidPayload", `${key} must be a NUL-free string.`);
  }
  return value;
}
