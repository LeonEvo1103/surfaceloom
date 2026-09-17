import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  NativeClientTransport, NativeTransportHandlers, NativeWriteReceipt,
} from "../client/transport.js";
import { NativeTransportWriteError } from "../client/transport.js";
import { snapshotNodeProcessOptions, type NodeProcessConfig } from "./config.js";
import { StdoutFramer } from "./framer.js";
import { deferred, ExitReceiptTracker, OneShotDeadline, shutdownOwnedChild } from "./lifecycle.js";
import { BoundedStderr } from "./stderr.js";
import {
  NodeProcessTransportError, type NodeProcessLifecycleSnapshot,
  type NodeProcessTransportOptions, type NodeProcessTransportState, type ProcessExitReceipt,
} from "./types.js";
import { ProcessWriter } from "./write-admission.js";

export class NodeChildProcessTransport implements NativeClientTransport {
  readonly #config: NodeProcessConfig;
  readonly #stderr: BoundedStderr;
  readonly #exitReceipt = new ExitReceiptTracker();
  readonly #childClosed = deferred<void>();
  readonly #startupDeadline: OneShotDeadline;
  #state: NodeProcessTransportState = "idle";
  #handlers: NativeTransportHandlers | null = null;
  #child: ChildProcessWithoutNullStreams | null = null;
  #writer: ProcessWriter | null = null;
  #framer: StdoutFramer | null = null;
  #childInstanceId: string | null = null;
  #pid: number | null = null;
  #spawned = false;
  #processExitObserved = false;
  #stdioClosed = false;
  #disconnectNotified = false;
  #openPromise: Promise<void> | null = null;
  #openResolve: (() => void) | null = null;
  #openReject: ((error: unknown) => void) | null = null;
  #openSettled = false;
  #childCloseSettled = false;
  #closePromise: Promise<void> | null = null;

  constructor(options: NodeProcessTransportOptions) {
    this.#config = snapshotNodeProcessOptions(options);
    this.#stderr = new BoundedStderr(this.#config.maxStderrBytes);
    this.#startupDeadline = new OneShotDeadline(this.#config.startupTimeoutMs, () => this.#startupExpired());
  }

  snapshot(): NodeProcessLifecycleSnapshot {
    return Object.freeze({ state: this.#state, childInstanceId: this.#childInstanceId,
      pid: this.#pid, spawned: this.#spawned, processExitObserved: this.#processExitObserved,
      stdioClosed: this.#stdioClosed, acceptingWrites: this.#writer?.accepting ?? false,
      outstandingWriteBytes: this.#writer?.outstandingBytes ?? 0,
      stderrBytesSeen: this.#stderr.bytesSeen, stderrTail: this.#stderr.tail,
      stderrTruncated: this.#stderr.truncated, exit: this.#exitReceipt.value,
      disconnectNotified: this.#disconnectNotified });
  }

  open(handlers: NativeTransportHandlers): Promise<void> {
    if (this.#state === "opening" && this.#openPromise !== null) return this.#openPromise;
    if (this.#state !== "idle") return Promise.reject(this.#notOpen("Transport cannot be reopened."));
    this.#state = "opening";
    this.#handlers = Object.freeze({ ...handlers });
    this.#childInstanceId = randomUUID();
    this.#openPromise = new Promise<void>((resolve, reject) => {
      this.#openResolve = resolve;
      this.#openReject = reject;
    });
    try {
      const child = spawn(this.#config.executable, [...this.#config.argv], {
        cwd: this.#config.cwd, env: { ...this.#config.env }, shell: false,
        detached: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      this.#child = child;
      this.#writer = new ProcessWriter(child.stdin, this.#config.maxOutstandingWriteBytes,
        this.#config.writeTimeoutMs, (error) => this.#fail(error));
      this.#wireChild(child);
      this.#startupDeadline.arm();
    } catch (cause) {
      const error = new NodeProcessTransportError("spawn_failed", "Native host spawn failed.", { cause });
      this.#state = "closed";
      this.#stdioClosed = true;
      this.#exitReceipt.settle(Object.freeze({ status: "notSpawned" }));
      this.#settleChildClose();
      this.#settleOpen(error);
    }
    return this.#openPromise;
  }

  write(frame: string): Promise<NativeWriteReceipt> {
    if (this.#state !== "open" || this.#writer === null) {
      return Promise.reject(new NativeTransportWriteError("beforeWrite", "Native process is not accepting writes."));
    }
    return this.#writer.write(frame);
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#writer?.stop();
    if (this.#state === "idle") {
      this.#state = "closed";
      this.#stdioClosed = true;
      this.#exitReceipt.settle(Object.freeze({ status: "notSpawned" }));
      this.#settleChildClose();
      this.#closePromise = Promise.resolve();
      return this.#closePromise;
    }
    if (this.#state === "closed") {
      this.#closePromise = Promise.resolve();
      return this.#closePromise;
    }
    this.#state = "closing";
    this.#settleOpen(this.#notOpen("Native process closed while opening."));
    this.#closePromise = this.#shutdown();
    return this.#closePromise;
  }

  waitForExit(): Promise<ProcessExitReceipt> { return this.#exitReceipt.wait(); }

  #wireChild(child: ChildProcessWithoutNullStreams): void {
    this.#framer = new StdoutFramer(this.#config.maxFrameBytes, (frame) => this.#handlers?.onFrame(frame));
    child.stdout.on("data", (chunk: Buffer) => {
      try { this.#framer?.push(chunk); } catch (error) { this.#fail(error); }
    });
    child.stdout.once("end", () => {
      try { this.#framer?.end(); } catch (error) { this.#fail(error); return; }
      if (this.#state === "open" || this.#state === "opening") {
        this.#fail(new NodeProcessTransportError("stdout_closed", "Native host stdout closed."));
      }
    });
    child.stdout.on("error", (cause) => this.#fail(
      new NodeProcessTransportError("stream_error", "Native host stdout failed.", { cause })));
    child.stderr.on("data", (chunk: Buffer) => this.#stderr.push(chunk));
    child.stderr.once("end", () => this.#stderr.end());
    child.stderr.on("error", () => { /* Diagnostic-only stream remains drained. */ });
    child.stdin.on("error", (cause) => {
      if (this.#writer?.accepting === true) this.#fail(
        new NodeProcessTransportError("stream_error", "Native host stdin failed.", { cause }));
    });
    child.once("spawn", () => this.#spawnObserved(child));
    child.once("error", (cause) => this.#processError(cause));
    child.once("exit", (code, signal) => this.#observeExit(code, signal));
    child.once("close", (code, signal) => this.#processClosed(code, signal));
  }

  #spawnObserved(child: ChildProcessWithoutNullStreams): void {
    this.#spawned = true;
    this.#pid = child.pid ?? null;
    if (this.#state !== "opening") return;
    this.#state = "open";
    this.#writer?.start();
    this.#settleOpen();
  }

  #processError(cause: unknown): void {
    const error = new NodeProcessTransportError(this.#spawned ? "stream_error" : "spawn_failed",
      this.#spawned ? "Native host process failed." : "Native host spawn failed.", { cause });
    if (!this.#spawned) {
      this.#exitReceipt.settle(Object.freeze({ status: "notSpawned" }));
      this.#settleOpen(error);
      void this.close().catch(() => {});
    } else this.#fail(error);
  }

  #processClosed(code: number | null, signal: NodeJS.Signals | null): void {
    try { this.#framer?.end(); } catch (error) { this.#fail(error); }
    this.#stderr.end();
    this.#stdioClosed = true;
    if (!this.#processExitObserved) this.#observeExit(code, signal);
    if (!this.#spawned) this.#exitReceipt.settle(Object.freeze({ status: "notSpawned" }));
    this.#settleChildClose();
    if (this.#state === "open" || this.#state === "opening") {
      this.#fail(new NodeProcessTransportError("process_exited", "Native host process exited."));
    }
  }

  #observeExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#processExitObserved || !this.#spawned) return;
    this.#processExitObserved = true;
    this.#writer?.stop();
    if (this.#pid !== null && this.#childInstanceId !== null) {
      this.#exitReceipt.settle(Object.freeze({ status: "exited", childInstanceId: this.#childInstanceId,
        pid: this.#pid, code, signal }));
    }
  }

  #startupExpired(): void {
    if (this.#state !== "opening") return;
    const error = new NodeProcessTransportError("startup_timeout", "Native host spawn timed out.");
    this.#framer?.abort();
    this.#settleOpen(error);
    void this.close().catch(() => {});
  }

  async #shutdown(): Promise<void> {
    const child = this.#child;
    if (child === null) { this.#state = "closed"; return; }
    const confirmed = await shutdownOwnedChild(child, this.#childClosed.promise,
      () => this.#childCloseSettled, this.#config.closeGraceMs, this.#config.forceCloseMs);
    if (!confirmed) {
      if (!this.#processExitObserved) {
        this.#exitReceipt.settle(Object.freeze({ status: "unconfirmed", reason: "forceCloseTimeout" }));
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      this.#state = "closed";
      throw new NodeProcessTransportError("close_unconfirmed",
        "Native host stdio did not close before the force-close deadline.");
    }
    this.#state = "closed";
  }

  #fail(cause: unknown): void {
    this.#framer?.abort();
    this.#writer?.stop();
    if (this.#state === "closing" || this.#state === "closed") return;
    this.#notifyDisconnect(cause);
    void this.close().catch(() => {});
  }

  #notifyDisconnect(cause: unknown): void {
    if (this.#disconnectNotified) return;
    this.#disconnectNotified = true;
    try { this.#handlers?.onDisconnect(cause); } catch { /* Observer failure cannot own cleanup. */ }
  }

  #settleOpen(error?: unknown): void {
    if (this.#openSettled) return;
    this.#openSettled = true;
    this.#startupDeadline.cancel();
    if (error === undefined) this.#openResolve?.(); else this.#openReject?.(error);
  }

  #settleChildClose(): void {
    if (this.#childCloseSettled) return;
    this.#childCloseSettled = true;
    this.#childClosed.resolve();
  }

  #notOpen(message: string): NodeProcessTransportError {
    return new NodeProcessTransportError("not_open", message);
  }
}
