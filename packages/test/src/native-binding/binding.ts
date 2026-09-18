import type { DesktopCapability } from "@surfaceloom/core";
import { createNativeCallContext } from "./call-context.js";
import { validateCleanupBudget } from "./cleanup-budget.js";
import {
  NativeBindingError,
  nativeAcquisitionContracts,
  nativeSessionOperationContracts,
  type NativeAcquisitionKind,
  type NativeBindingCallOptions,
  type NativeBindingOptions,
  type NativeOperationContract,
  type NativeOperationResult,
  type NativeSessionIdentity,
  type NativeSessionOperation,
} from "./contracts.js";
import { DeferredNativeAcquisition, registerNativeResources } from "./resources.js";

export type NativeSessionOperationFor<O extends NativeSessionIdentity["ownership"]> =
  O extends "borrowed" ? Exclude<NativeSessionOperation, "quit" | "terminate"> : NativeSessionOperation;

export interface NativeSessionBinding<O extends NativeSessionIdentity["ownership"] = NativeSessionIdentity["ownership"]> {
  readonly session: NativeSessionIdentity & { readonly ownership: O };
  readonly capabilities: readonly DesktopCapability[];
  invoke<T>(operation: NativeSessionOperationFor<O>, payload?: Readonly<Record<string, unknown>>,
    options?: Partial<NativeBindingCallOptions>): Promise<NativeOperationResult<T>>;
}

export function acquireNativeApplication(options: NativeBindingOptions, kind: "launch",
  callOptions?: Partial<NativeBindingCallOptions>): Promise<NativeSessionBinding<"owned">>;
export function acquireNativeApplication(options: NativeBindingOptions, kind: "attach",
  callOptions?: Partial<NativeBindingCallOptions>): Promise<NativeSessionBinding<"borrowed">>;
export function acquireNativeApplication(options: NativeBindingOptions, kind: NativeAcquisitionKind,
  callOptions?: Partial<NativeBindingCallOptions>): Promise<NativeSessionBinding>;
export async function acquireNativeApplication(options: NativeBindingOptions,
  kind: NativeAcquisitionKind, callOptions: Partial<NativeBindingCallOptions> = {}): Promise<NativeSessionBinding> {
  validateHandshake(options);
  const cleanupSettleTimeoutMs = validateCleanupBudget(options.cleanupSettleTimeoutMs ?? 250);
  const contract = nativeAcquisitionContracts[kind];
  const acquisition = new DeferredNativeAcquisition();
  registerNativeResources({ context: options.context, acquisition, handshake: options.handshake,
    port: options.port, targetOwnership: contract.ownership!, ownsProtocol: options.ownsProtocol ?? true,
    ownsHost: options.ownsHost ?? true, cleanupSettleTimeoutMs,
    resourceNamespace: options.resourceNamespace ?? "native",
    registerHostResource: options.registerHostResource ?? true,
    ...(options.cleanupClock === undefined ? {} : { cleanupClock: options.cleanupClock.now }),
    ...(options.lease === undefined ? {} : { lease: options.lease }) });
  try {
    const result = await options.context.dispatch(contract.effect, async () => {
      const call = createNativeCallContext(options.context, callOptions);
      try {
        precheck(options, contract, undefined);
        options.context.throwIfCancelled();
        return await options.port.acquire(kind, call.beforeSubmit());
      } finally { call.dispose(); }
    });
    validateIdentity(result.value, options, contract.ownership!);
    acquisition.acquired(result.value);
    requireExecuted(result);
    return createBinding(options, result.value);
  } catch (error) {
    if (operationOutcome(error) === "unknown") {
      acquisition.reconcile(
        () => options.port.reconcileLateAcquisition({ timeoutMs: options.reconciliationTimeoutMs ?? 250 }),
        options.reconciliationTimeoutMs ?? 250,
        (session) => validateIdentity(session, options, contract.ownership!),
      );
    } else acquisition.unknown(reason(error));
    throw error;
  }
}

function createBinding<O extends NativeSessionIdentity["ownership"]>(options: NativeBindingOptions,
  session: NativeSessionIdentity & { readonly ownership: O }): NativeSessionBinding<O> {
  const capabilities = effectiveCapabilities(options);
  return Object.freeze({ session, capabilities,
    invoke: <T>(operation: NativeSessionOperation,
      payload: Readonly<Record<string, unknown>> = {},
      explicit: Partial<NativeBindingCallOptions> = {}): Promise<NativeOperationResult<T>> => {
      if (!Object.hasOwn(nativeSessionOperationContracts, operation)) {
        return Promise.reject(new NativeBindingError("invalidOperation", "Unknown or acquisition-only native operation."));
      }
      const contract = nativeSessionOperationContracts[operation];
      return options.context.dispatch(contract.effect, async () => {
        const call = createNativeCallContext(options.context, explicit);
        try {
          precheck(options, contract, session);
          options.context.throwIfCancelled();
          const wirePayload = contract.action === undefined ? payload
            : Object.freeze({ ...payload, action: contract.action });
          return await options.port.invoke<T>(session, contract, wirePayload, call.beforeSubmit());
        } finally { call.dispose(); }
      });
    } });
}

function precheck(options: NativeBindingOptions, contract: NativeOperationContract,
  session: NativeSessionIdentity | undefined): void {
  if (!effectiveCapabilities(options).includes(contract.capability)) {
    throw new NativeBindingError("capabilityMismatch", `Native capability is unavailable: ${contract.capability}.`);
  }
  const advertised = options.handshake.methods.find((item) => item.name === contract.method);
  if (advertised === undefined || advertised.intent !== contract.intent
    || !advertised.scopeKinds.includes(contract.scope)) {
    throw new NativeBindingError("capabilityMismatch",
      `Host does not advertise ${contract.method}/${contract.intent}/${contract.scope}.`);
  }
  if (session === undefined) return;
  if (contract.scope === "host") throw new NativeBindingError("invalidOperation", "Session invoke cannot use host scope.");
  if (session.hostInstanceId !== options.handshake.hostInstanceId) {
    throw new NativeBindingError("staleScope", "Native session belongs to a stale host instance.");
  }
  if (session.sessionId.trim() === "") {
    throw new NativeBindingError("staleScope", "Session-scoped operation lacks a live session identity.");
  }
  if (contract.scope === "handle" && session.handleId.trim() === "") {
    throw new NativeBindingError("staleScope", "Handle-scoped operation lacks a live handle identity.");
  }
  if (contract.ownership !== undefined && session.ownership !== contract.ownership) {
    throw new NativeBindingError("wrongOwnership", `${contract.method} requires ${contract.ownership} ownership.`);
  }
}

function validateHandshake(options: NativeBindingOptions): void {
  if (options.handshake.platform !== options.environmentPlatform) {
    throw new NativeBindingError("capabilityMismatch", "Native handshake platform does not match the environment.");
  }
}

function validateIdentity(session: NativeSessionIdentity, options: NativeBindingOptions,
  ownership: NativeSessionIdentity["ownership"]): void {
  if (session.hostInstanceId !== options.handshake.hostInstanceId) {
    throw new NativeBindingError("staleScope", "Native acquisition returned a stale host identity.");
  }
  if (session.ownership !== ownership || session.surface !== "application") {
    throw new NativeBindingError("wrongOwnership", "Native acquisition returned the wrong surface ownership.");
  }
  if (session.sessionId.trim() === "" || session.handleId.trim() === ""
    || session.targetIdentity.trim() === "") {
    throw new NativeBindingError("staleScope", "Native acquisition returned an incomplete session identity.");
  }
}

function requireExecuted(result: NativeOperationResult<NativeSessionIdentity>): void {
  if (result.operation?.outcome !== "executed") {
    throw new NativeBindingError("invalidReceipt", "Native acquisition lacks an executed receipt.");
  }
}

function effectiveCapabilities(options: NativeBindingOptions): readonly DesktopCapability[] {
  const contracts = [...Object.values(nativeAcquisitionContracts), ...Object.values(nativeSessionOperationContracts)];
  const advertised = new Set(contracts.filter((contract) => options.handshake.methods.some((method) =>
    method.name === contract.method && method.intent === contract.intent && method.scopeKinds.includes(contract.scope)))
    .map((contract) => contract.capability));
  return Object.freeze([...new Set(options.environmentCapabilities.filter((item) => advertised.has(item)))]);
}

function operationOutcome(error: unknown): unknown {
  return (error as { operationOutcome?: unknown } | null)?.operationOutcome;
}
function reason(error: unknown): string {
  return `Acquisition did not return a cleanup identity: ${error instanceof Error ? error.message : "unknown error"}`;
}
