import type { HostDescriptor, NativeHandle, NativeSessionDescriptor, OperationReceipt } from "../index.js";
import type { NodeProcessTransportOptions, ProcessExitReceipt } from "../node-transport/index.js";

export type WindowsDesktopCapability = "app.launch" | "app.attach" | "app.quit" | "app.terminate"
  | "ui.inspect" | "ui.invoke" | "ui.set-value";

export interface WindowsHostProcessOptions extends NodeProcessTransportOptions {
  readonly executable: string;
  readonly cwd: string;
}

export interface WindowsControllerOptions {
  /** Logical configuration identity. It is distinct from the per-process handshake identity. */
  readonly hostId: string;
  readonly process: WindowsHostProcessOptions;
  readonly environmentCapabilities?: readonly WindowsDesktopCapability[];
}

export interface WindowsWaitOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export type WindowsElementScope = "element" | "children" | "descendants" | "subtree";

/** Exact Windows v1 locator shape. Selector arrays are AND groups and may not all be empty. */
export interface WindowsUiaLocator {
  readonly automationIds: readonly string[];
  readonly names: readonly string[];
  readonly controlTypes: readonly string[];
  readonly classNames: readonly string[];
  readonly frameworkIds: readonly string[];
  readonly nativeWindowHandle: number | null;
  readonly scope: WindowsElementScope;
  readonly matchIndex: number | null;
}

export interface WindowsElementSnapshot {
  readonly elementId: string;
  readonly name: string;
  readonly automationId: string;
  readonly controlType: string;
  readonly className: string;
  readonly frameworkId: string;
  readonly processId: number;
  readonly nativeWindowHandle: number;
  readonly isEnabled: boolean;
  readonly isOffscreen: boolean;
  readonly value: string | null;
  readonly hasKeyboardFocus: boolean;
  readonly isSelected: boolean | null;
  readonly toggleState: string | null;
  readonly expandCollapseState: string | null;
  readonly ariaRole: string | null;
  readonly ariaProperties: string | null;
  readonly isReadOnly: boolean | null;
  readonly supportedActions: readonly string[];
}

export interface WindowsElement {
  readonly handle: NativeHandle;
  readonly snapshot: WindowsElementSnapshot;
  readonly locator: WindowsUiaLocator;
  readonly rootHandleId: string;
}

export interface WindowsHostCapabilities {
  readonly protocolVersion: "1.0";
  readonly platform: "windows";
  readonly backend: "windows-ui-automation";
  readonly methods: readonly string[];
  readonly features: Readonly<Record<string, "supported" | "conditional" | "unsupported">>;
}

export interface WindowsConnectedHost {
  readonly logicalHostId: string;
  readonly host: HostDescriptor;
  readonly capabilities: WindowsHostCapabilities;
  readonly effectiveCapabilities: readonly WindowsDesktopCapability[];
  readonly childIdentity: string;
}

export interface WindowsLaunchOptions {
  readonly executablePath: string;
  readonly arguments?: readonly string[];
  readonly workingDirectory?: string;
  readonly environment?: Readonly<Record<string, string>>;
  /** The v1 Windows binding requires a root window identity. False is unsupported. */
  readonly waitForWindow?: true;
  readonly window?: WindowsUiaLocator;
  readonly wait?: Partial<WindowsWaitOptions>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface WindowsAttachOptions {
  readonly processId: number;
  readonly window?: WindowsUiaLocator;
  readonly wait?: Partial<WindowsWaitOptions>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface WindowsOperationOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly operationId?: string;
}

export interface WindowsOperationResult<T> {
  readonly value: T;
  readonly operation: OperationReceipt | null;
}

export interface WindowsEndProof {
  readonly kind: "targetExit";
  readonly hostInstanceId: string;
  readonly sessionId: string;
  readonly handleId: string;
  readonly targetIdentity: string;
}

export interface WindowsReleaseProof {
  readonly kind: "sessionRelease";
  readonly hostInstanceId: string;
  readonly sessionId: string;
}

export interface WindowsHostExitProof {
  readonly kind: "hostChildExit";
  readonly hostInstanceId: string;
  readonly hostChildIdentity: string;
  readonly exit: ProcessExitReceipt;
}

export interface WindowsSessionSeed {
  readonly descriptor: NativeSessionDescriptor;
  readonly root: WindowsElementSnapshot | null;
  readonly configuredProcessId: number | null;
  readonly acquisitionReceipt: OperationReceipt;
}
