import {
  acquireNativeApplication, type CaseContext, type NativeBindingCallOptions,
  nativeSessionOperationContracts,
  type NativeHostHandshake, type NativeSessionBinding,
  type NativeSurfaceRequirement, type SurfaceOwnership,
} from "@surfaceloom/test";

import type { WindowsControllerOptions, WindowsDesktopCapability, WindowsUiaLocator } from "../contracts.js";
import { WindowsNativeController } from "../controller.js";
import { WindowsNativeError } from "../error.js";
import { strictLocator } from "../validation.js";
import { WindowsV3BindingPort, type WindowsBindingTarget } from "./binding-port.js";
import type {
  WindowsNativeAction, WindowsNativeSurfaceBackendPort, WindowsNativeSurfaceSessionPort,
  WindowsSurfaceBackendCall, WindowsSurfaceSetupContext,
} from "./contracts.js";
import { WindowsV3Deadline } from "./deadline.js";
import { registerWindowsHostCleanup } from "./host-cleanup.js";

export interface WindowsNativeSurfaceBackendOptions extends WindowsControllerOptions {
  /** Stable requirement target id to explicit launch/attach configuration. */
  readonly targets: Readonly<Record<string, WindowsBindingTarget>>;
  readonly cleanupSettleTimeoutMs?: number;
  readonly reconciliationTimeoutMs?: number;
}

export function createWindowsNativeSurfaceBackend(
  options: WindowsNativeSurfaceBackendOptions,
): WindowsNativeSurfaceBackendPort {
  assertTargetsSupported(options.targets);
  const declared = Object.freeze([...(options.environmentCapabilities ?? defaultCapabilities)]);
  return Object.freeze({
    hostId: options.hostId,
    platform: "windows" as const,
    backend: "uia" as const,
    capabilities: declared,
    prepare<O extends SurfaceOwnership>(requirement: NativeSurfaceRequirement<"windows", O>,
      context: WindowsSurfaceSetupContext) {
      const deadline = new WindowsV3Deadline(context, requirement.timeoutMs);
      const target = bindingTarget(requirement, options.targets);
      const controller = new WindowsNativeController({ hostId: options.hostId, process: options.process,
        ...(options.environmentCapabilities === undefined ? {} : {
          environmentCapabilities: options.environmentCapabilities,
        }) });
      registerWindowsHostCleanup(context, requirement.surfaceId, options.hostId, controller);
      return Object.freeze({ acquire: (call: WindowsSurfaceBackendCall) =>
        acquire(controller, target, requirement, context, call, deadline, options) });
    },
  });
}

async function acquire<O extends SurfaceOwnership>(controller: WindowsNativeController,
  target: WindowsBindingTarget, requirement: NativeSurfaceRequirement<"windows", O>,
  context: WindowsSurfaceSetupContext, call: WindowsSurfaceBackendCall,
  deadline: WindowsV3Deadline,
  options: WindowsNativeSurfaceBackendOptions): Promise<WindowsNativeSurfaceSessionPort<O>> {
  const connected = await controller.connect(deadline.remaining());
  const bindingPort = new WindowsV3BindingPort(controller, target, () => submission(call, deadline));
  const caseContext = bindingContext(context);
  const handshake: NativeHostHandshake = Object.freeze({ hostInstanceId: connected.host.hostInstanceId,
    hostChildIdentity: connected.childIdentity, platform: "windows", backend: connected.host.backend,
    methods: Object.freeze(connected.host.methods.filter((method) => method.name !== "host.handshake")
      .map((method) => Object.freeze({ name: method.name, intent: method.intent,
        scopeKinds: Object.freeze(method.scopeKinds.filter((scope): scope is "host" | "session" | "handle" =>
          scope !== "bootstrap")) }))) });
  const binding = await acquireNativeApplication({ context: caseContext, handshake,
    environmentPlatform: "windows", environmentCapabilities: connected.effectiveCapabilities,
    port: bindingPort, ownsHost: false, registerHostResource: false,
    resourceNamespace: `native.${requirement.surfaceId}.session`,
    ...(options.cleanupSettleTimeoutMs === undefined ? {} : {
      cleanupSettleTimeoutMs: options.cleanupSettleTimeoutMs,
    }), ...(options.reconciliationTimeoutMs === undefined ? {} : {
      reconciliationTimeoutMs: options.reconciliationTimeoutMs,
    }) }, target.kind, { timeoutMs: deadline.remaining(), signal: call.signal });
  return new WindowsV3SurfaceSession(binding as NativeSessionBinding<O>, bindingPort);
}

class WindowsV3SurfaceSession<O extends SurfaceOwnership>
implements WindowsNativeSurfaceSessionPort<O> {
  readonly platform = "windows" as const;
  readonly backend = "uia" as const;
  readonly ownership: O;
  readonly capabilities: readonly WindowsDesktopCapability[];
  constructor(readonly binding: NativeSessionBinding<O>, readonly port: WindowsV3BindingPort) {
    this.ownership = binding.session.ownership;
    this.capabilities = binding.capabilities as readonly WindowsDesktopCapability[];
  }

  async invoke(action: WindowsNativeAction<O>, context: WindowsSurfaceSetupContext,
    call: WindowsSurfaceBackendCall): Promise<unknown> {
    const deadline = new WindowsV3Deadline(context);
    const options: NativeBindingCallOptions = { timeoutMs: deadline.remaining(), signal: call.signal };
    switch (action.kind) {
      case "find": return this.dispatch("find", { locator: surfaceLocator(action.locator) }, context, call,
        deadline, options);
      case "invoke": return this.dispatch("invoke", { locator: surfaceLocator(action.locator) }, context, call,
        deadline, options);
      case "setValue": return this.dispatch("setValue",
        { locator: surfaceLocator(action.locator), value: action.value }, context, call, deadline, options);
      case "quit": return this.dispatch("quit", {}, context, call, deadline, options);
      case "terminate": return this.dispatch("terminate", {}, context, call, deadline, options);
    }
  }

  private dispatch(operation: keyof typeof nativeSessionOperationContracts,
    payload: Readonly<Record<string, unknown>>, context: WindowsSurfaceSetupContext,
    call: WindowsSurfaceBackendCall, deadline: WindowsV3Deadline,
    options: NativeBindingCallOptions): Promise<unknown> {
    const contract = nativeSessionOperationContracts[operation];
    if (!this.capabilities.includes(contract.capability as WindowsDesktopCapability)) {
      return Promise.reject(new WindowsNativeError("capabilityMismatch",
        `Windows capability is unavailable: ${contract.capability}.`));
    }
    return context.dispatch(contract.effect, async () =>
      (await this.port.invokeSurface(this.binding.session, contract, payload, options,
        () => submission(call, deadline))).value);
  }
}

function submission(call: WindowsSurfaceBackendCall, deadline: WindowsV3Deadline): NativeBindingCallOptions {
  const outer = call.beforeSubmit();
  return Object.freeze({ signal: outer.signal, timeoutMs: Math.min(outer.timeoutMs, deadline.remaining()) });
}

function assertTargetsSupported(targets: Readonly<Record<string, WindowsBindingTarget>>): void {
  for (const target of Object.values(targets)) {
    if (target.kind === "launch" && (target.options as { readonly waitForWindow?: unknown }).waitForWindow === false) {
      throw new WindowsNativeError("invalidConfiguration",
        "Windows v1 launch requires waitForWindow; waitForWindow:false is unsupported.");
    }
  }
}

function bindingTarget<O extends SurfaceOwnership>(requirement: NativeSurfaceRequirement<"windows", O>,
  targets: Readonly<Record<string, WindowsBindingTarget>>):
WindowsBindingTarget {
  const target = targets[requirement.target];
  if (target === undefined) {
    throw new WindowsNativeError("invalidPayload", "Windows requirement target is not explicitly configured.");
  }
  if (target.kind !== requirement.acquisition) {
    throw new WindowsNativeError("invalidPayload", "Windows target acquisition does not match the requirement.");
  }
  return target;
}

function surfaceLocator(value: Readonly<{ automationId?: string; controlType?: string; name?: string }>):
WindowsUiaLocator {
  return strictLocator(Object.freeze({ automationIds: value.automationId === undefined ? [] : [value.automationId],
    names: value.name === undefined ? [] : [value.name],
    controlTypes: value.controlType === undefined ? [] : [value.controlType],
    classNames: [], frameworkIds: [], nativeWindowHandle: null, scope: "descendants", matchIndex: null }));
}

function bindingContext(context: WindowsSurfaceSetupContext): CaseContext {
  return { signal: context.signal, remainingMs: () => context.remainingMs(),
    throwIfCancelled: () => { if (context.signal.aborted) throw new WindowsNativeError("deadline", "Case cancelled."); },
    acknowledgeCancellation: () => false,
    fixture: () => { throw new WindowsNativeError("invalidPayload", "Fixtures are unavailable inside a surface adapter."); },
    step: async (_step, body) => body(), criterion: async (_id, check) => check(),
    registerResource: (resource) => context.registerResource(resource),
    dispatch: (effect, action) => context.dispatch(effect, action) } as CaseContext;
}

const defaultCapabilities = Object.freeze([
  "app.launch", "app.attach", "app.quit", "app.terminate", "ui.inspect", "ui.invoke", "ui.set-value",
] as const satisfies readonly WindowsDesktopCapability[]);
