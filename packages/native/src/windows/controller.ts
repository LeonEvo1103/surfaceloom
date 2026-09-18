import { randomUUID } from "node:crypto";
import { types } from "node:util";

import { NativeClient } from "../client/index.js";
import type { JsonObject, NativeSessionDescriptor, OperationReceipt } from "../contracts.js";
import { NodeChildProcessTransport, type ProcessExitReceipt } from "../node-transport/index.js";
import { effectiveWindowsCapabilities } from "./capabilities.js";
import { windowsHostCapabilitiesCodec, windowsSessionCodec } from "./codecs.js";
import type {
  WindowsAttachOptions, WindowsConnectedHost, WindowsControllerOptions, WindowsDesktopCapability,
  WindowsHostExitProof, WindowsLaunchOptions, WindowsSessionSeed,
} from "./contracts.js";
import { WindowsDeadline } from "./deadline.js";
import {
  createWindowsDesktopSession, type WindowsDesktopSession,
} from "./desktop-session.js";
import { WindowsNativeError } from "./error.js";
import { WindowsLateAcquisitionMailbox } from "./late-acquisition.js";
import { normalizeWindowsError } from "./normalize-error.js";
import { jsonEnvironment, jsonStringArray, locatorPayload, waitPayload } from "./payloads.js";
import { WindowsDesktopSessionState } from "./session.js";
import { absolutePath, capabilities, integer, stableId, strictLocator, timeout, waitOptions } from "./validation.js";

interface SnapshotOptions {
  readonly hostId: string;
  readonly process: WindowsControllerOptions["process"];
  readonly environmentCapabilities: readonly WindowsDesktopCapability[];
}

export class WindowsNativeController {
  readonly hostId: string;
  readonly declaredCapabilities: readonly WindowsDesktopCapability[];
  readonly #transport: NodeChildProcessTransport;
  readonly #client: NativeClient;
  readonly #late = new WindowsLateAcquisitionMailbox();
  readonly #sessions = new Map<string, WindowsDesktopSessionState>();
  #connected: WindowsConnectedHost | null = null;
  #recoverable: WindowsDesktopSessionState | null = null;
  #close: Promise<ProcessExitReceipt> | null = null;

  constructor(options: WindowsControllerOptions) {
    const snapshot = snapshotOptions(options);
    this.hostId = snapshot.hostId;
    this.declaredCapabilities = snapshot.environmentCapabilities;
    this.#transport = new NodeChildProcessTransport(snapshot.process);
    this.#client = new NativeClient({ transport: this.#transport, onLateResponse: this.#late.accept });
  }

  get connectedHost(): WindowsConnectedHost | null { return this.#connected; }

  async connect(timeoutMs = 5_000): Promise<WindowsConnectedHost> {
    if (this.#connected !== null) return this.#connected;
    const deadline = new WindowsDeadline(timeoutMs, undefined);
    try {
      const host = await this.#client.connect(deadline.remaining());
      if (host.platform !== "windows" || host.backend !== "uia") {
        throw new WindowsNativeError("invalidHandshake", "Native host is not the Windows UIA v1 backend.");
      }
      const result = await this.#client.invoke({ name: "capabilities.get", intent: "observe",
        scope: { kind: "host", hostInstanceId: host.hostInstanceId }, payload: {},
        timeoutMs: deadline.remaining(), codec: windowsHostCapabilitiesCodec });
      const described = new Set(host.methods.map((method) => method.name));
      if (result.value.methods.length !== described.size
          || result.value.methods.some((method) => !described.has(method))) {
        throw new WindowsNativeError("invalidHandshake", "Host descriptor and capability methods disagree.");
      }
      const lifecycle = this.#transport.snapshot();
      if (lifecycle.childInstanceId === null || lifecycle.pid === null) {
        throw new WindowsNativeError("invalidHandshake", "Native host child identity is unavailable.");
      }
      this.#connected = Object.freeze({ logicalHostId: this.hostId, host,
        capabilities: result.value,
        effectiveCapabilities: effectiveWindowsCapabilities(this.declaredCapabilities, host, result.value),
        childIdentity: lifecycle.childInstanceId });
      return this.#connected;
    } catch (error) {
      const primary = normalizeWindowsError(error, "Windows native host connection failed.");
      try { await this.close(); } catch (cleanup) {
        throw new AggregateError([primary, cleanup], "Windows host connection and cleanup failed.");
      }
      throw primary;
    }
  }

  launch(options: WindowsLaunchOptions): Promise<WindowsDesktopSession<"owned">> {
    if ((options as { readonly waitForWindow?: unknown }).waitForWindow === false) {
      return Promise.reject(new WindowsNativeError("invalidConfiguration",
        "Windows v1 launch requires waitForWindow; waitForWindow:false is unsupported."));
    }
    absolutePath(options.executablePath, "launch executablePath");
    return this.acquire("launch", launchPayload(options), null, options.timeoutMs, options.signal)
      .then((session) => createWindowsDesktopSession<"owned">(session));
  }

  attach(options: WindowsAttachOptions): Promise<WindowsDesktopSession<"borrowed">> {
    const processId = integer(options.processId, "attach processId", 1);
    return this.acquire("attach", attachPayload(options, processId), processId, options.timeoutMs, options.signal)
      .then((session) => createWindowsDesktopSession<"borrowed">(session));
  }

  async reconcileLate(kind: "launch", timeoutMs?: number): Promise<WindowsDesktopSession<"owned"> | null>;
  async reconcileLate(kind: "attach", timeoutMs?: number): Promise<WindowsDesktopSession<"borrowed"> | null>;
  async reconcileLate(kind: "launch" | "attach", timeoutMs = 250): Promise<WindowsDesktopSession<"owned"> |
  WindowsDesktopSession<"borrowed"> | null> {
    if (this.#recoverable !== null) return kind === "launch"
      ? createWindowsDesktopSession<"owned">(this.#recoverable)
      : createWindowsDesktopSession<"borrowed">(this.#recoverable);
    const acquired = await this.#late.wait(kind, timeoutMs);
    if (acquired === null) return null;
    const tracked = this.#client.trackSession(acquired.session);
    const state = this.remember(new WindowsDesktopSessionState(this.#client,
      { descriptor: tracked, root: null, configuredProcessId: null, acquisitionReceipt: acquired.receipt },
      this.requireConnected().effectiveCapabilities));
    return kind === "launch" ? createWindowsDesktopSession<"owned">(state)
      : createWindowsDesktopSession<"borrowed">(state);
  }

  async close(): Promise<ProcessExitReceipt> {
    if (this.#close !== null) return this.#close;
    this.#close = (async () => {
      await this.#client.close();
      return this.#transport.waitForExit();
    })();
    return this.#close;
  }

  async closeHostProof(): Promise<WindowsHostExitProof> {
    const connected = this.requireConnected();
    const exit = await this.close();
    if (exit.status !== "exited" || exit.childInstanceId !== connected.childIdentity) {
      throw new WindowsNativeError("cleanupUnconfirmed", "Windows host child exit is unconfirmed.");
    }
    return Object.freeze({ kind: "hostChildExit", hostInstanceId: connected.host.hostInstanceId,
      hostChildIdentity: connected.childIdentity, exit });
  }

  private async acquire(kind: "launch" | "attach", payload: JsonObject, configuredProcessId: number | null,
    timeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<WindowsDesktopSessionState> {
    const connected = this.requireConnected();
    const deadline = new WindowsDeadline(timeoutMs, signal);
    let operation: OperationReceipt | null = null;
    const operationId = `windows-${kind}-${randomUUID()}`;
    try {
      const result = await this.#client.invoke({ name: `session.${kind}`, intent: "lifecycle",
        scope: { kind: "host", hostInstanceId: connected.host.hostInstanceId }, payload,
        operationId,
        timeoutMs: deadline.remaining(), ...(signal === undefined ? {} : { signal }), codec: windowsSessionCodec });
      operation = result.operation;
      requireExecuted(operation, kind);
      const expectedOwnership = kind === "launch" ? "owned" : "borrowed";
      if (result.value.ownership !== expectedOwnership || result.value.surface !== "application") {
        throw new WindowsNativeError("invalidResult", "Windows acquisition returned the wrong ownership or surface.",
          { operationReceipt: operation });
      }
      const session = this.remember(new WindowsDesktopSessionState(this.#client, {
        descriptor: result.value, root: null, configuredProcessId, acquisitionReceipt: operation,
      }, connected.effectiveCapabilities));
      this.#recoverable = session;
      await session.observeRoot({ timeoutMs: deadline.remaining(), ...(signal === undefined ? {} : { signal }) });
      this.#recoverable = null;
      return session;
    } catch (error) {
      const normalized = normalizeWindowsError(error, `Windows session ${kind} failed.`, operationId);
      if (this.#recoverable !== null || operation?.outcome === "executed") {
        throw new WindowsNativeError(normalized.code, normalized.message, { cause: normalized,
          operationReceipt: operation ?? normalized.operationReceipt, operationOutcome: "unknown" });
      }
      throw normalized;
    }
  }

  private remember(session: WindowsDesktopSessionState): WindowsDesktopSessionState {
    this.#sessions.set(session.descriptor.sessionId, session);
    return session;
  }
  private requireConnected(): WindowsConnectedHost {
    if (this.#connected === null) throw new WindowsNativeError("invalidHandshake", "Windows host is not connected.");
    return this.#connected;
  }
}

function snapshotOptions(options: WindowsControllerOptions): SnapshotOptions {
  if (typeof options !== "object" || options === null || types.isProxy(options)) {
    throw new WindowsNativeError("invalidConfiguration", "Windows controller options must be plain data.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !["hostId", "process", "environmentCapabilities"].includes(key))) {
    throw new WindowsNativeError("invalidConfiguration", "Windows controller options contain unknown fields.");
  }
  const read = (key: string): unknown => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new WindowsNativeError("invalidConfiguration", `Windows controller ${key} must be data.`);
    }
    return descriptor.value;
  };
  const process = read("process") as WindowsControllerOptions["process"];
  return Object.freeze({ hostId: stableId(read("hostId"), "Windows logical hostId"), process,
    environmentCapabilities: capabilities(descriptors.environmentCapabilities === undefined
      ? undefined : read("environmentCapabilities") as readonly WindowsDesktopCapability[]) });
}

function launchPayload(options: WindowsLaunchOptions): JsonObject {
  const budget = timeout(options.timeoutMs);
  return Object.freeze({ executable: { path: absolutePath(options.executablePath, "launch executablePath"),
    arguments: jsonStringArray(options.arguments ?? []) },
  ...(options.workingDirectory === undefined ? {} : { workingDirectory:
    absolutePath(options.workingDirectory, "launch workingDirectory") }),
  environment: jsonEnvironment(options.environment ?? {}), desktop: "default",
  waitForWindow: options.waitForWindow ?? true,
  ...(options.window === undefined ? {} : { window: locatorPayload(strictLocator(options.window)) }),
  wait: waitPayload(waitOptions(options.wait, budget)) }) as JsonObject;
}

function attachPayload(options: WindowsAttachOptions, processId: number): JsonObject {
  const budget = timeout(options.timeoutMs);
  return Object.freeze({ processId, desktop: "default",
    ...(options.window === undefined ? {} : { window: locatorPayload(strictLocator(options.window)) }),
    wait: waitPayload(waitOptions(options.wait, budget)) }) as JsonObject;
}

function requireExecuted(receipt: OperationReceipt | null, operation: string): asserts receipt is OperationReceipt {
  if (receipt?.outcome !== "executed") throw new WindowsNativeError("invalidResult",
    `Windows ${operation} did not return an executed receipt.`, { operationReceipt: receipt });
}
