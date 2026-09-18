import type { NativeClient, NativeInvocationResult } from "../client/index.js";
import type { JsonObject, NativeHandle, NativeSessionDescriptor, OperationReceipt } from "../contracts.js";
import { assertHandleScope } from "../schema.js";
import {
  windowsElementCodec, windowsElementTupleCodec, windowsEndCodec, windowsReleaseCodec,
} from "./codecs.js";
import type {
  WindowsDesktopCapability, WindowsElement, WindowsElementSnapshot, WindowsEndProof,
  WindowsOperationOptions, WindowsReleaseProof, WindowsSessionSeed, WindowsUiaLocator,
} from "./contracts.js";
import { WindowsDeadline } from "./deadline.js";
import { WindowsNativeError } from "./error.js";
import { normalizeWindowsError } from "./normalize-error.js";
import { locatorPayload, waitPayload } from "./payloads.js";
import { strictLocator, timeout, waitOptions } from "./validation.js";

export class WindowsDesktopSessionState {
  readonly descriptor: NativeSessionDescriptor;
  readonly capabilities: readonly WindowsDesktopCapability[];
  readonly configuredProcessId: number | null;
  readonly acquisitionReceipt: OperationReceipt;
  #rootSnapshot: WindowsElementSnapshot | null;
  #removed = false;
  #end: Promise<NativeInvocationResult<unknown>> | null = null;

  constructor(readonly client: NativeClient, seed: WindowsSessionSeed,
    capabilities: readonly WindowsDesktopCapability[], readonly now: () => number = () => performance.now()) {
    this.descriptor = seed.descriptor;
    this.#rootSnapshot = seed.root;
    this.configuredProcessId = seed.configuredProcessId;
    this.acquisitionReceipt = seed.acquisitionReceipt;
    this.capabilities = Object.freeze([...capabilities]);
  }

  get ownership(): "owned" | "borrowed" { return this.descriptor.ownership; }
  get targetIdentity(): string {
    return this.#rootSnapshot === null ? `windows-session:${this.descriptor.sessionId}`
      : `windows-process:${this.#rootSnapshot.processId}`;
  }
  get rootHandle(): NativeHandle { return this.descriptor.root; }
  get removed(): boolean { return this.#removed; }

  async observeRoot(options: WindowsOperationOptions = {}): Promise<WindowsElementSnapshot> {
    if (this.#rootSnapshot !== null) return this.#rootSnapshot;
    const deadline = new WindowsDeadline(options.timeoutMs, options.signal, this.now);
    try {
      const result = await this.client.invoke({ name: "element.get", intent: "observe",
        scope: { kind: "handle", ...this.descriptor.root }, payload: {}, timeoutMs: deadline.remaining(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        codec: windowsElementTupleCodec(this.descriptor, this.descriptor.root) });
      const snapshot = result.value.snapshot;
      if (this.configuredProcessId !== null && snapshot.processId !== this.configuredProcessId) {
        throw new WindowsNativeError("invalidResult", "Attached root process does not match the configured PID.",
          { operationReceipt: result.operation });
      }
      this.#rootSnapshot = snapshot;
      return snapshot;
    } catch (error) { throw normalizeWindowsError(error, "Windows root observation failed."); }
  }

  async find(locator: WindowsUiaLocator, options: WindowsOperationOptions = {}):
  Promise<NativeInvocationResult<WindowsElement>> {
    this.requireActive();
    const checked = strictLocator(locator);
    const deadline = new WindowsDeadline(options.timeoutMs, options.signal, this.now);
    try {
      const result = await this.client.invoke({ name: "element.find", intent: "observe",
        scope: this.sessionScope(), payload: { locator: locatorPayload(checked),
          wait: waitPayload(waitOptions(undefined, deadline.remaining())) },
        timeoutMs: deadline.remaining(), ...(options.signal === undefined ? {} : { signal: options.signal }),
        codec: windowsElementCodec(this.descriptor, checked, this.descriptor.root.handleId) });
      return result;
    } catch (error) { throw normalizeWindowsError(error, "Windows element lookup failed."); }
  }

  async get(handle: NativeHandle, options: WindowsOperationOptions = {}):
  Promise<NativeInvocationResult<WindowsElementSnapshot>> {
    this.requireActive();
    assertHandleScope(this.descriptor, handle);
    const deadline = new WindowsDeadline(options.timeoutMs, options.signal, this.now);
    try {
      const result = await this.client.invoke({ name: "element.get", intent: "observe",
        scope: { kind: "handle", ...handle }, payload: {}, timeoutMs: deadline.remaining(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        codec: windowsElementTupleCodec(this.descriptor, handle) });
      return Object.freeze({ value: result.value.snapshot, operation: result.operation });
    } catch (error) { throw normalizeWindowsError(error, "Windows element observation failed."); }
  }

  invoke(locator: WindowsUiaLocator, options: WindowsOperationOptions = {}):
  Promise<NativeInvocationResult<WindowsElementSnapshot>> {
    return this.action("invoke", locator, undefined, options, (deadline) => ({
      timeoutMs: deadline.remaining(), ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
    }));
  }

  setValue(locator: WindowsUiaLocator, value: string,
    options: WindowsOperationOptions = {}): Promise<NativeInvocationResult<WindowsElementSnapshot>> {
    if (typeof value !== "string" || value.includes("\0")) {
      return Promise.reject(new WindowsNativeError("invalidPayload", "Windows setValue requires a NUL-free string."));
    }
    return this.action("setValue", locator, value, options, (deadline) => ({
      timeoutMs: deadline.remaining(), ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
    }));
  }

  invokeAtSubmission(locator: WindowsUiaLocator, options: WindowsOperationOptions,
    beforeSubmit: () => WindowsOperationOptions): Promise<NativeInvocationResult<WindowsElementSnapshot>> {
    return this.action("invoke", locator, undefined, options, () => beforeSubmit());
  }

  setValueAtSubmission(locator: WindowsUiaLocator, value: string, options: WindowsOperationOptions,
    beforeSubmit: () => WindowsOperationOptions): Promise<NativeInvocationResult<WindowsElementSnapshot>> {
    if (typeof value !== "string" || value.includes("\0")) {
      return Promise.reject(new WindowsNativeError("invalidPayload", "Windows setValue requires a NUL-free string."));
    }
    return this.action("setValue", locator, value, options, () => beforeSubmit());
  }

  close(options: WindowsOperationOptions = {}): Promise<NativeInvocationResult<unknown>> {
    return this.end("session.close", options);
  }

  terminate(options: WindowsOperationOptions = {}): Promise<NativeInvocationResult<unknown>> {
    return this.end("session.terminate", options);
  }

  async cleanupTarget(options: WindowsOperationOptions = {}): Promise<WindowsEndProof> {
    if (this.ownership !== "owned") throw new WindowsNativeError("wrongOwnership", "Borrowed targets are not ended.");
    if (!this.#removed) await this.terminate(options);
    return Object.freeze({ kind: "targetExit", hostInstanceId: this.descriptor.hostInstanceId,
      sessionId: this.descriptor.sessionId, handleId: this.descriptor.root.handleId,
      targetIdentity: this.targetIdentity });
  }

  async release(options: WindowsOperationOptions = {}): Promise<WindowsReleaseProof> {
    if (this.#removed) return this.releaseProof();
    if (this.ownership === "owned") {
      throw new WindowsNativeError("wrongOwnership", "A running owned target must end before release.");
    }
    const deadline = new WindowsDeadline(options.timeoutMs, options.signal, this.now);
    const operationId = options.operationId ?? `windows-release-${randomUUID()}`;
    try {
      const result = await this.client.invoke({ name: "session.release", intent: "lifecycle",
        scope: this.sessionScope(), payload: {}, timeoutMs: deadline.remaining(),
        operationId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        codec: windowsReleaseCodec(this.descriptor.sessionId) });
      requireExecuted(result.operation, "release");
      this.markRemoved();
      return this.releaseProof();
    } catch (error) { throw normalizeWindowsError(error, "Windows session release failed.", operationId); }
  }

  private async action(kind: "invoke" | "setValue", locator: WindowsUiaLocator,
    value: string | undefined, options: WindowsOperationOptions,
    beforeSubmit: (deadline: WindowsDeadline) => WindowsOperationOptions):
  Promise<NativeInvocationResult<WindowsElementSnapshot>> {
    const deadline = new WindowsDeadline(options.timeoutMs, options.signal, this.now);
    const found = await this.find(locator, { timeoutMs: deadline.remaining(),
      ...(options.signal === undefined ? {} : { signal: options.signal }) });
    const target = found.value;
    const payload: JsonObject = { action: kind, ...(value === undefined ? {} : { value }),
      expectedTarget: { locator: locatorPayload(target.locator), processId: target.snapshot.processId,
        rootElementId: target.rootHandleId } };
    let operationId = options.operationId;
    try {
      const submitted = beforeSubmit(deadline);
      operationId = submitted.operationId ?? operationId ?? `windows-action-${randomUUID()}`;
      const result = await this.client.invoke({ name: "element.action", intent: "mutate",
        scope: { kind: "handle", ...target.handle }, payload,
        operationId, timeoutMs: Math.min(deadline.remaining(), timeout(submitted.timeoutMs)),
        ...(submitted.signal === undefined ? {} : { signal: submitted.signal }),
        codec: windowsElementCodec(this.descriptor, target.locator, target.rootHandleId) });
      requireExecuted(result.operation, kind);
      return Object.freeze({ value: result.value.snapshot, operation: result.operation });
    } catch (error) {
      throw normalizeWindowsError(error, `Windows ${kind} failed.`, operationIdFrom(error, operationId));
    }
  }

  private end(method: "session.close" | "session.terminate",
    options: WindowsOperationOptions): Promise<NativeInvocationResult<unknown>> {
    if (this.ownership !== "owned") return Promise.reject(
      new WindowsNativeError("wrongOwnership", "Borrowed sessions have no destructive lifecycle action."));
    if (this.#end !== null) return this.#end;
    const deadline = new WindowsDeadline(options.timeoutMs, options.signal, this.now);
    const operationId = options.operationId ?? `windows-end-${randomUUID()}`;
    const requestedAction = method === "session.close" ? "close" : "terminate";
    this.#end = this.client.invoke({ name: method, intent: "lifecycle", scope: this.sessionScope(),
      payload: { wait: waitPayload(waitOptions(undefined, deadline.remaining())) },
      operationId,
      timeoutMs: deadline.remaining(), ...(options.signal === undefined ? {} : { signal: options.signal }),
      codec: windowsEndCodec({ sessionId: this.descriptor.sessionId, requestedAction,
        processId: this.#rootSnapshot?.processId ?? this.configuredProcessId }) }).then((result) => {
        requireExecuted(result.operation, method); this.markRemoved(); return result;
      }, (error: unknown) => {
        const normalized = normalizeWindowsError(error, `Windows ${method} failed.`, operationId);
        if (normalized.operationOutcome !== "unknown" && normalized.operationOutcome !== "executed") {
          this.#end = null;
        }
        throw normalized;
      });
    return this.#end;
  }

  private markRemoved(): void { this.#removed = true; this.client.forgetSession(this.descriptor.sessionId); }
  private releaseProof(): WindowsReleaseProof { return Object.freeze({ kind: "sessionRelease",
    hostInstanceId: this.descriptor.hostInstanceId, sessionId: this.descriptor.sessionId }); }
  private sessionScope(): { kind: "session"; hostInstanceId: string; sessionId: string } {
    return { kind: "session", hostInstanceId: this.descriptor.hostInstanceId,
      sessionId: this.descriptor.sessionId };
  }
  private requireActive(): void {
    if (this.#removed) throw new WindowsNativeError("staleHandle", "Windows session is no longer active.");
  }
}

function operationIdFrom(error: unknown, fallback: string | undefined): string | undefined {
  if (error instanceof WindowsNativeError && error.operationReceipt !== null) {
    return error.operationReceipt.operationId;
  }
  return fallback;
}

function requireExecuted(receipt: OperationReceipt | null, operation: string): void {
  if (receipt?.outcome !== "executed") throw new WindowsNativeError("invalidResult",
    `Windows ${operation} did not return an executed receipt.`, { operationReceipt: receipt });
}
import { randomUUID } from "node:crypto";
