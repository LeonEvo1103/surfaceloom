import { maxDeadlineMs, maxWireMessageBytes, nativeProtocolName, nativeProtocolVersion } from "../constants.js";
import type {
  CancellationReason, HostDescriptor, JsonObject, NativeHandle, NativeSessionDescriptor,
  OperationOutcome, WireCancel, WireRequest, WireResponse,
} from "../contracts.js";
import { disconnectedOperationOutcome, validateResponseForRequest } from "../correlation.js";
import { encodeWireLine, parseWireLine } from "../framing.js";
import { NativeProtocolError } from "../protocol-error.js";
import {
  assertHandleScope, validateCallAgainstHost, validateHostDescriptor, validateNativeHandle,
  validateSessionDescriptor, validateWireMessage,
} from "../schema.js";
import type { NativeCodecContext, NativeResultCodec } from "./codec.js";
import { NativeClientError, NativeRemoteError } from "./errors.js";
import type {
  NativeClientOptions, NativeClientRuntime, NativeClientSnapshot, NativeClientState,
  NativeInvocation, NativeInvocationResult,
} from "./types.js";
import { NativeTransportWriteError, type NativeWritePhase } from "./transport.js";

interface Pending<T = unknown> {
  request: WireRequest;
  readonly codec: NativeResultCodec<T>;
  readonly resolve: (result: NativeInvocationResult<T>) => void;
  readonly reject: (error: unknown) => void;
  readonly deadlineAt: number;
  phase: NativeWritePhase;
  timer: unknown;
  abortListener?: () => void;
  signal?: AbortSignal;
}

interface OpeningAttempt {
  readonly epoch: number;
  readonly reject: (error: unknown) => void;
  timer: unknown;
}

const defaultRuntime: NativeClientRuntime = Object.freeze({
  now: () => performance.now(),
  setTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimer: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

/** A single negotiated connection to one immutable host instance. */
export class NativeClient {
  readonly #transport: NativeClientOptions["transport"];
  readonly #runtime: NativeClientRuntime;
  readonly #idFactory: (kind: "request" | "operation" | "cancel") => string;
  readonly #onLateResponse: NativeClientOptions["onLateResponse"];
  readonly #pending = new Map<string, Pending>();
  readonly #dispatchedRequests = new Map<string, WireRequest>();
  readonly #awaitingLateResponseIds = new Set<string>();
  readonly #allocatedIds = new Set<string>();
  readonly #sessions = new Map<string, NativeSessionDescriptor>();
  readonly #seenSessionIds = new Set<string>();
  readonly #handles = new Map<string, NativeHandle>();
  #state: NativeClientState = "idle";
  #host: HostDescriptor | null = null;
  #counter = 0;
  #connectionEpoch = 0;
  #opening: OpeningAttempt | null = null;
  #transportClose: Promise<void> | null = null;

  constructor(options: NativeClientOptions) {
    this.#transport = options.transport;
    this.#runtime = options.runtime ?? defaultRuntime;
    this.#idFactory = options.idFactory ?? ((kind) => `${kind}-${++this.#counter}`);
    this.#onLateResponse = options.onLateResponse;
  }

  snapshot(): NativeClientSnapshot {
    return Object.freeze({ state: this.#state, host: this.#host,
      activeRequestCount: this.#pending.size, trackedSessionCount: this.#sessions.size,
      trackedHandleCount: this.#handles.size });
  }

  async connect(timeoutMs = 5_000): Promise<HostDescriptor> {
    if (this.#state !== "idle") throw this.#stateError();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > maxDeadlineMs) {
      throw new NativeProtocolError("invalid_message", `timeoutMs must be an integer between 0 and ${maxDeadlineMs}.`);
    }
    const startedAt = this.#runtime.now();
    const epoch = ++this.#connectionEpoch;
    this.#state = "connecting";
    try {
      await this.#openWithinDeadline(timeoutMs, epoch);
      if (this.#state !== "connecting" || this.#connectionEpoch !== epoch) throw this.#stateError();
      const remaining = Math.max(0, timeoutMs - Math.max(0, Math.ceil(this.#runtime.now() - startedAt)));
      const result = await this.#dispatch({ name: "host.handshake", intent: "observe",
        scope: { kind: "bootstrap" }, payload: {}, timeoutMs: remaining,
        codec: { decode: (value) => validateHostDescriptor(value) } });
      if (this.#state !== "connecting" || this.#connectionEpoch !== epoch) throw this.#stateError();
      this.#host = result.value;
      this.#state = "ready";
      return result.value;
    } catch (error) {
      if (this.snapshot().state !== "disconnected" && this.snapshot().state !== "closed") {
        this.#state = "disconnected";
      }
      // Connection failure must settle independently of a broken close().
      this.#beginTransportClose();
      throw error;
    }
  }

  invoke<T>(invocation: NativeInvocation<T>): Promise<NativeInvocationResult<T>> {
    if (this.#state !== "ready") return Promise.reject(this.#stateError());
    return this.#dispatch(invocation);
  }

  async launchSession(options: {
    readonly payload: JsonObject;
    readonly timeoutMs: number;
    readonly operationId?: string;
    readonly signal?: AbortSignal;
  }): Promise<NativeInvocationResult<NativeSessionDescriptor>> {
    const host = this.#requireHost();
    return this.invoke({ name: "session.launch", intent: "lifecycle",
      scope: { kind: "host", hostInstanceId: host.hostInstanceId }, payload: options.payload,
      timeoutMs: options.timeoutMs, ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      codec: { decode: (value, context) => context.trackSession(validateSessionDescriptor(value)) } });
  }

  trackSession(value: NativeSessionDescriptor): NativeSessionDescriptor {
    const stagedSessions = new Map<string, NativeSessionDescriptor>();
    const stagedHandles = new Map<string, NativeHandle>();
    const session = this.#stageSession(value, stagedSessions, stagedHandles);
    this.#commitTracking(stagedSessions, stagedHandles);
    return session;
  }

  trackHandle(value: NativeHandle): NativeHandle {
    const stagedHandles = new Map<string, NativeHandle>();
    const handle = this.#stageHandle(value, new Map(), stagedHandles);
    this.#commitTracking(new Map(), stagedHandles);
    return handle;
  }

  forgetSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
    for (const [key, handle] of this.#handles) if (handle.sessionId === sessionId) this.#handles.delete(key);
  }

  async close(): Promise<void> {
    if (this.#state === "closed") {
      if (this.#transportClose !== null) await this.#transportClose;
      return;
    }
    this.#connectionEpoch += 1;
    this.#state = "closed";
    this.#rejectOpening(this.#stateError());
    const pending = [...this.#pending.values()];
    for (const item of pending) this.#cancelPending(item, "shutdown");
    this.#host = null;
    this.#sessions.clear();
    this.#handles.clear();
    await this.#closeTransport();
  }

  async #dispatch<T>(invocation: NativeInvocation<T>): Promise<NativeInvocationResult<T>> {
    const startedAt = this.#runtime.now();
    if (!Number.isSafeInteger(invocation.timeoutMs) || invocation.timeoutMs < 0
      || invocation.timeoutMs > maxDeadlineMs) {
      throw new NativeProtocolError("invalid_message", `timeoutMs must be an integer between 0 and ${maxDeadlineMs}.`);
    }
    if (invocation.signal?.aborted === true) {
      throw new NativeClientError("cancelled", "Native request was cancelled before write.", {
        operationOutcome: invocation.intent === "observe" ? null : "notExecuted", writePhase: "beforeWrite",
      });
    }
    const host = this.#host;
    if (invocation.name !== "host.handshake") {
      if (host === null) throw this.#stateError();
      this.#validateScope(invocation.scope);
    }
    const operationId = invocation.intent === "observe" ? undefined
      : this.#allocateId("operation", invocation.operationId);
    const requestId = this.#allocateId("request");
    const prepared = validateWireMessage({ protocol: nativeProtocolName, version: nativeProtocolVersion,
      type: "request", id: requestId, deadline: { timeoutMs: invocation.timeoutMs }, call: {
        name: invocation.name, intent: invocation.intent, scope: invocation.scope,
        payload: invocation.payload, ...(operationId === undefined ? {} : { operationId }),
      } }) as WireRequest;
    if (host !== null) validateCallAgainstHost(prepared.call, host);
    const maximumFrameBytes = host?.maxMessageBytes ?? maxWireMessageBytes;
    const provisionalEncodeStarted = this.#runtime.now();
    const provisionalFrame = encodeWireLine(prepared);
    this.#assertFrameBoundary(provisionalFrame, maximumFrameBytes);
    const measuredEncodeMs = Math.max(0,
      Math.ceil(this.#runtime.now() - provisionalEncodeStarted));
    // One millisecond is reserved in addition to the measured provisional
    // encode. If the final encode exceeds it, the post-encode invariant below
    // fails closed instead of attempting convergence by repeated serialization.
    const encodeReserveMs = measuredEncodeMs + 1;
    let request = prepared;
    let frame = provisionalFrame;
    const deadlineAt = startedAt + invocation.timeoutMs;

    return new Promise<NativeInvocationResult<T>>((resolve, reject) => {
      const pending: Pending<T> = { request, codec: invocation.codec, resolve, reject,
        deadlineAt, phase: "beforeWrite", timer: undefined };
      this.#pending.set(request.id, pending as Pending);
      if (invocation.signal !== undefined) {
        pending.signal = invocation.signal;
        pending.abortListener = () => this.#cancelPending(pending as Pending, "caller");
        invocation.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      pending.timer = this.#runtime.setTimer(() => this.#cancelPending(pending as Pending, "deadline"),
        Math.max(0, deadlineAt - this.#runtime.now()));
      // Listener/timer registration also belongs to the caller's budget. One
      // final encode follows setup; no payload is serialized in a retry loop.
      try {
        const elapsedBeforeFinalEncode = Math.max(0, Math.ceil(this.#runtime.now() - startedAt));
        const finalRemaining = invocation.timeoutMs - elapsedBeforeFinalEncode - encodeReserveMs;
        if (finalRemaining <= 0) throw this.#preWriteDeadline(requestId, invocation.intent);
        request = validateWireMessage({ ...prepared,
          deadline: { timeoutMs: finalRemaining } }) as WireRequest;
        frame = encodeWireLine(request);
        this.#assertFrameBoundary(frame, maximumFrameBytes);
        const writeStartElapsed = Math.max(0, Math.ceil(this.#runtime.now() - startedAt));
        if (writeStartElapsed + finalRemaining > invocation.timeoutMs) {
          throw this.#preWriteDeadline(requestId, invocation.intent);
        }
        pending.request = request;
      } catch (error) {
        this.#settle(pending as Pending);
        reject(error);
        return;
      }
      pending.phase = "writing";
      this.#dispatchedRequests.set(request.id, this.#requestTombstone(request));
      let write: Promise<import("./transport.js").NativeWriteReceipt>;
      try { write = this.#transport.write(frame); }
      catch (error) { this.#writeFailed(pending as Pending, error); return; }
      void Promise.resolve(write).then((receipt) => {
        if (receipt.bytesWritten !== Buffer.byteLength(frame, "utf8")) {
          throw new NativeTransportWriteError(receipt.bytesWritten === 0 ? "beforeWrite" : "writing",
            "Transport did not write the complete request frame.");
        }
        pending.phase = "written";
      }).catch((error: unknown) => this.#writeFailed(pending as Pending, error));
    });
  }

  #receive(frame: string): void {
    if (this.#state === "closed") return;
    let response: WireResponse;
    try {
      if (this.#host !== null && this.#wireFrameBytes(frame) > this.#host.maxMessageBytes) {
        throw new NativeProtocolError("message_too_large", "Response exceeds the negotiated host frame boundary.");
      }
      const message = parseWireLine(frame);
      if (message.type !== "response") throw new NativeClientError("protocol_violation", "Client received a non-response frame.");
      response = message;
    } catch (error) {
      this.#protocolFailure(error);
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      const dispatched = this.#dispatchedRequests.get(response.id);
      if (dispatched !== undefined && this.#awaitingLateResponseIds.delete(response.id)) {
        try { validateResponseForRequest(dispatched, response); }
        catch (error) { this.#protocolFailure(error); return; }
        try {
          this.#onLateResponse?.(Object.freeze({ request: Object.freeze({ id: dispatched.id,
            name: dispatched.call.name, intent: dispatched.call.intent,
            operationId: dispatched.call.operationId ?? null }), response,
            responsibility: "callerReconciliation", cleanupConfirmed: false }));
        } catch { /* Audit observers do not own transport lifecycle. */ }
        return;
      }
      if (dispatched !== undefined) return;
      this.#protocolFailure(new NativeClientError("protocol_violation", "Received an unsolicited response frame."));
      return;
    }
    try { validateResponseForRequest(pending.request, response); }
    catch (error) { this.#protocolFailure(error); return; }
    this.#settle(pending);
    if (!response.ok) {
      pending.reject(new NativeRemoteError(response.error, response.operation));
      return;
    }
    try {
      const stagedSessions = new Map<string, NativeSessionDescriptor>();
      const stagedHandles = new Map<string, NativeHandle>();
      const context: NativeCodecContext = Object.freeze({
        trackSession: (session: NativeSessionDescriptor) =>
          this.#stageSession(session, stagedSessions, stagedHandles),
        trackHandle: (handle: NativeHandle) =>
          this.#stageHandle(handle, stagedSessions, stagedHandles),
      });
      const value = pending.codec.decode(response.result, context);
      this.#commitTracking(stagedSessions, stagedHandles);
      pending.resolve(Object.freeze({ value, operation: response.operation }));
    } catch (error) {
      pending.reject(new NativeClientError("decode_failed", "Native result codec rejected the response.", {
        requestId: pending.request.id, writePhase: pending.phase,
        operationOutcome: response.operation?.outcome ?? null, cause: error,
      }));
    }
  }

  #validateScope(scope: NativeInvocation<unknown>["scope"]): void {
    const host = this.#requireHost();
    if (scope.kind === "bootstrap") this.#stale("Bootstrap scope is valid only during handshake.");
    if (scope.hostInstanceId !== host.hostInstanceId) this.#stale("Scope targets a stale host instance.");
    if (scope.kind === "session" || scope.kind === "handle") {
      const session = this.#sessions.get(scope.sessionId);
      if (session === undefined) this.#stale("Scope targets an unknown or stale session.");
      if (session.hostInstanceId !== scope.hostInstanceId) this.#stale("Session scope targets a stale host instance.");
    }
    if (scope.kind === "handle" && !this.#handles.has(this.#handleKey(scope))) {
      this.#stale("Scope targets an unknown or stale handle.");
    }
  }

  #cancelPending(pending: Pending, reason: CancellationReason): void {
    if (!this.#pending.has(pending.request.id)) return;
    const outcome = disconnectedOperationOutcome(pending.request, pending.phase);
    if (pending.phase !== "beforeWrite") this.#awaitingLateResponseIds.add(pending.request.id);
    this.#settle(pending);
    pending.reject(new NativeClientError(reason === "deadline" ? "deadline" : "cancelled",
      reason === "deadline" ? "Native request exceeded its deadline." : "Native request was cancelled.", {
        requestId: pending.request.id, operationOutcome: outcome, writePhase: pending.phase,
      }));
    if (pending.phase !== "beforeWrite") void this.#sendCancel(pending.request.id, reason);
  }

  async #sendCancel(requestId: string, reason: CancellationReason): Promise<void> {
    try {
      const cancel = validateWireMessage({ protocol: nativeProtocolName, version: nativeProtocolVersion,
        type: "cancel", id: this.#allocateId("cancel"), requestId, reason }) as WireCancel;
      await this.#transport.write(encodeWireLine(cancel));
    } catch { /* best effort; cancellation is not stop proof */ }
  }

  #writeFailed(pending: Pending, error: unknown): void {
    if (!this.#pending.has(pending.request.id)) return;
    const phase = error instanceof NativeTransportWriteError ? error.phase : "writing";
    pending.phase = phase;
    const outcome = disconnectedOperationOutcome(pending.request, phase);
    if (phase !== "beforeWrite") this.#awaitingLateResponseIds.add(pending.request.id);
    this.#settle(pending);
    pending.reject(new NativeClientError("write_failed", "Native request write failed.", {
      requestId: pending.request.id, operationOutcome: outcome, writePhase: phase, cause: error,
    }));
  }

  #disconnect(cause?: unknown): void {
    if (this.#state === "closed" || this.#state === "disconnected") return;
    this.#state = "disconnected";
    this.#connectionEpoch += 1;
    this.#rejectOpening(new NativeClientError("disconnected", "Native transport disconnected.", { cause }));
    this.#host = null;
    this.#sessions.clear();
    this.#handles.clear();
    for (const pending of [...this.#pending.values()]) {
      const outcome = disconnectedOperationOutcome(pending.request, pending.phase);
      if (pending.phase !== "beforeWrite") this.#awaitingLateResponseIds.add(pending.request.id);
      this.#settle(pending);
      pending.reject(new NativeClientError("disconnected", "Native transport disconnected.", {
        requestId: pending.request.id, operationOutcome: outcome, writePhase: pending.phase, cause,
      }));
    }
  }

  #protocolFailure(error: unknown): void {
    this.#state = "disconnected";
    this.#connectionEpoch += 1;
    this.#rejectOpening(new NativeClientError("protocol_violation", "Native protocol validation failed.", {
      cause: error,
    }));
    this.#host = null;
    this.#sessions.clear();
    this.#handles.clear();
    for (const pending of [...this.#pending.values()]) {
      this.#settle(pending);
      pending.reject(new NativeClientError("protocol_violation", "Native protocol validation failed.", {
        requestId: pending.request.id, writePhase: pending.phase,
        operationOutcome: disconnectedOperationOutcome(pending.request, pending.phase), cause: error,
      }));
    }
    this.#beginTransportClose();
  }

  #settle(pending: Pending): void {
    this.#pending.delete(pending.request.id);
    this.#runtime.clearTimer(pending.timer);
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }

  #assertFrameBoundary(frame: string, advertisedMaximum: number): void {
    if (this.#wireFrameBytes(frame) > Math.min(maxWireMessageBytes, advertisedMaximum)) {
      throw new NativeProtocolError("message_too_large", "Request exceeds the negotiated host frame boundary.");
    }
  }

  #requireHost(): HostDescriptor {
    if (this.#host === null) throw this.#stateError();
    return this.#host;
  }

  #stateError(): NativeClientError {
    const code = this.#state === "closed" ? "closed"
      : this.#state === "disconnected" ? "disconnected" : "not_connected";
    return new NativeClientError(code, `Native client is ${this.#state}.`);
  }

  #stale(message: string): never { throw new NativeClientError("stale_scope", message); }
  #preWriteDeadline(requestId: string, intent: NativeInvocation<unknown>["intent"]): NativeClientError {
    return new NativeClientError("deadline", "Native request deadline expired before transport write.", {
      requestId, operationOutcome: intent === "observe" ? null : "notExecuted", writePhase: "beforeWrite",
    });
  }
  #openWithinDeadline(timeoutMs: number, epoch: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const attempt: OpeningAttempt = { epoch, reject, timer: undefined };
      this.#opening = attempt;
      const finish = (error?: unknown): void => {
        if (this.#opening !== attempt) return;
        this.#opening = null;
        this.#runtime.clearTimer(attempt.timer);
        if (error === undefined) resolve(); else reject(error);
      };
      attempt.timer = this.#runtime.setTimer(() => {
        if (this.#opening !== attempt) return;
        this.#state = "disconnected";
        this.#connectionEpoch += 1;
        finish(new NativeClientError("deadline", "Native transport open exceeded its deadline."));
        this.#beginTransportClose();
      }, timeoutMs);
      let opening: Promise<void>;
      try {
        opening = this.#transport.open({
          onFrame: (frame) => this.#receive(frame),
          onDisconnect: (cause) => this.#disconnect(cause),
        });
      } catch (error) { finish(error); return; }
      void Promise.resolve(opening).then(() => finish(), (error: unknown) => finish(error));
    });
  }
  #rejectOpening(error: unknown): void {
    const opening = this.#opening;
    if (opening === null) return;
    this.#opening = null;
    this.#runtime.clearTimer(opening.timer);
    opening.reject(error);
  }
  #stageSession(value: NativeSessionDescriptor, sessions: Map<string, NativeSessionDescriptor>,
    handles: Map<string, NativeHandle>): NativeSessionDescriptor {
    const session = validateSessionDescriptor(value);
    const host = this.#requireHost();
    if (session.hostInstanceId !== host.hostInstanceId) this.#stale("Session belongs to a stale host instance.");
    const prior = sessions.get(session.sessionId) ?? this.#sessions.get(session.sessionId);
    if (prior === undefined && this.#seenSessionIds.has(session.sessionId)) {
      this.#stale("Session id was reused after its previous identity was released.");
    }
    if (prior !== undefined && (prior.hostInstanceId !== session.hostInstanceId
      || prior.root.handleId !== session.root.handleId)) this.#stale("Session id was reused with different identity.");
    sessions.set(session.sessionId, session);
    handles.set(this.#handleKey(session.root), session.root);
    return session;
  }
  #stageHandle(value: NativeHandle, sessions: Map<string, NativeSessionDescriptor>,
    handles: Map<string, NativeHandle>): NativeHandle {
    const handle = validateNativeHandle(value);
    const session = sessions.get(handle.sessionId) ?? this.#sessions.get(handle.sessionId);
    if (session === undefined) this.#stale("Handle belongs to an unknown or stale session.");
    assertHandleScope(session, handle);
    handles.set(this.#handleKey(handle), handle);
    return handle;
  }
  #commitTracking(sessions: Map<string, NativeSessionDescriptor>, handles: Map<string, NativeHandle>): void {
    for (const [sessionId, session] of sessions) {
      this.#sessions.set(sessionId, session);
      this.#seenSessionIds.add(sessionId);
    }
    for (const [key, handle] of handles) this.#handles.set(key, handle);
  }
  #allocateId(kind: "request" | "operation" | "cancel", explicit?: string): string {
    const id = explicit ?? this.#idFactory(kind);
    if (this.#allocatedIds.has(id)) {
      throw new NativeClientError("protocol_violation", `Native ${kind} id was reused.`);
    }
    this.#allocatedIds.add(id);
    return id;
  }
  #handleKey(handle: NativeHandle): string {
    return `${handle.hostInstanceId}\0${handle.sessionId}\0${handle.handleId}`;
  }
  #requestTombstone(request: WireRequest): WireRequest {
    // Late-response correlation must survive for the connection lifetime, but
    // retaining arbitrary method payloads would turn tombstones into a memory
    // and data-retention hazard.
    return Object.freeze({ ...request, deadline: Object.freeze({ ...request.deadline }),
      call: Object.freeze({ ...request.call, payload: Object.freeze({}) }) });
  }
  #wireFrameBytes(frame: string): number {
    return Buffer.byteLength(frame, "utf8") + (/\r?\n$/u.test(frame) ? 0 : 1);
  }
  #closeTransport(): Promise<void> {
    this.#transportClose ??= Promise.resolve().then(() => this.#transport.close())
      .catch((cause: unknown) => {
        throw new NativeClientError("close_failed", "Native transport close failed; cleanup is unconfirmed.", {
          cause,
        });
      });
    return this.#transportClose;
  }
  #beginTransportClose(): void {
    // Preserve the primary lifecycle failure. Explicit close() can still await
    // the same cached rejection and observe that cleanup was not confirmed.
    void this.#closeTransport().catch(() => {});
  }
}
