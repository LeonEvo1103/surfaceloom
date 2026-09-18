import type { NativeInvocationResult } from "../client/index.js";
import type { NativeHandle, NativeSessionDescriptor, OperationReceipt } from "../contracts.js";
import {
  BoundedDesktopSessionJournal, JournaledDesktopSessionOperationPort,
  type ApplicationDesktopSession, type NativeLifecycleOptions, type UiaLocator,
} from "../desktop-session/index.js";
import type {
  WindowsDesktopCapability, WindowsElement, WindowsElementSnapshot, WindowsOperationOptions,
  WindowsUiaLocator,
} from "./contracts.js";
import { WindowsDesktopSessionState } from "./session.js";
import { strictLocator } from "./validation.js";

export interface WindowsCoreSession {
  readonly id: string;
  readonly platform: "windows";
  readonly descriptor: NativeSessionDescriptor;
  readonly capabilities: readonly WindowsDesktopCapability[];
  readonly configuredProcessId: number | null;
  readonly acquisitionReceipt: OperationReceipt;
  readonly targetIdentity: string;
  readonly rootHandle: NativeHandle;
  readonly removed: boolean;
  observeRoot(options?: WindowsOperationOptions): Promise<WindowsElementSnapshot>;
  find(locator: WindowsUiaLocator, options?: WindowsOperationOptions): Promise<NativeInvocationResult<WindowsElement>>;
  get(handle: NativeHandle, options?: WindowsOperationOptions): Promise<NativeInvocationResult<WindowsElementSnapshot>>;
  invoke(locator: WindowsUiaLocator, options?: WindowsOperationOptions): Promise<NativeInvocationResult<WindowsElementSnapshot>>;
  setValue(locator: WindowsUiaLocator, value: string,
    options?: WindowsOperationOptions): Promise<NativeInvocationResult<WindowsElementSnapshot>>;
  invokeAtSubmission(locator: WindowsUiaLocator, options: WindowsOperationOptions,
    beforeSubmit: () => WindowsOperationOptions): Promise<NativeInvocationResult<WindowsElementSnapshot>>;
  setValueAtSubmission(locator: WindowsUiaLocator, value: string, options: WindowsOperationOptions,
    beforeSubmit: () => WindowsOperationOptions): Promise<NativeInvocationResult<WindowsElementSnapshot>>;
}

export type WindowsDesktopSession<O extends "owned" | "borrowed"> =
  ApplicationDesktopSession<"windows", WindowsCoreSession> & { readonly ownership: O };

export function createWindowsDesktopSession<O extends "owned" | "borrowed">(
  state: WindowsDesktopSessionState,
): WindowsDesktopSession<O> {
  const identity = Object.freeze({ hostInstanceId: state.descriptor.hostInstanceId,
    sessionId: state.descriptor.sessionId, handleId: state.descriptor.root.handleId });
  const evidence = new BoundedDesktopSessionJournal();
  const journaled = new JournaledDesktopSessionOperationPort(state.client, identity, evidence);
  const operationPort = Object.freeze({ platform: "windows" as const, invoke: journaled.invoke.bind(journaled) });
  const common = { id: state.descriptor.sessionId, platform: "windows" as const,
    descriptor: state.descriptor, capabilities: state.capabilities,
    configuredProcessId: state.configuredProcessId, acquisitionReceipt: state.acquisitionReceipt,
    rootHandle: state.rootHandle, observeRoot: state.observeRoot.bind(state), find: state.find.bind(state),
    get: state.get.bind(state), invoke: state.invoke.bind(state), setValue: state.setValue.bind(state),
    invokeAtSubmission: state.invokeAtSubmission.bind(state),
    setValueAtSubmission: state.setValueAtSubmission.bind(state), surface: "application" as const,
    backend: "uia" as const, nativeIdentity: identity, operationPort, evidence,
    nativeActions: Object.freeze({ resolve: async (value: UiaLocator) =>
      (await state.find(publicLocator(value))).value.handle }) };
  if (state.ownership === "borrowed") {
    return liveFacade({ ...common, ownership: "borrowed" as const,
      cleanupPort: Object.freeze({ release: (options?: NativeLifecycleOptions) => state.release(options) })
    }, state) as unknown as WindowsDesktopSession<O>;
  }
  return liveFacade({ ...common, ownership: "owned" as const, lifecyclePort: Object.freeze({
    quit: (options?: NativeLifecycleOptions) => nullResult(state.close(options)),
    terminate: (options?: NativeLifecycleOptions) => nullResult(state.terminate(options)),
  }), cleanupPort: Object.freeze({
    targetExit: (options?: NativeLifecycleOptions) => state.cleanupTarget(options),
    release: (options?: NativeLifecycleOptions) => state.release(options),
  }) }, state) as unknown as WindowsDesktopSession<O>;
}

function liveFacade<T extends object>(value: T, state: WindowsDesktopSessionState): Readonly<T> {
  Object.defineProperties(value, {
    targetIdentity: { enumerable: true, get: () => state.targetIdentity },
    removed: { enumerable: true, get: () => state.removed },
  });
  return Object.freeze(value);
}

async function nullResult(pending: Promise<NativeInvocationResult<unknown>>): Promise<NativeInvocationResult<null>> {
  const result = await pending;
  return Object.freeze({ value: null, operation: result.operation });
}

function publicLocator(value: UiaLocator): WindowsUiaLocator {
  return strictLocator(Object.freeze({ automationIds: value.automationId === undefined ? [] : [value.automationId],
    names: value.name === undefined ? [] : [value.name],
    controlTypes: value.controlType === undefined ? [] : [value.controlType],
    classNames: [], frameworkIds: [], nativeWindowHandle: null, scope: "descendants", matchIndex: null }));
}
