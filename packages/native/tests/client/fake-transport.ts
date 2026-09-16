import { Buffer } from "node:buffer";
import type { NativeWireMessage } from "../../src/contracts.js";
import { encodeWireLine, parseWireLine } from "../../src/framing.js";
import type {
  NativeClientRuntime, NativeClientTransport, NativeTransportHandlers, NativeWriteReceipt,
} from "../../src/client/index.js";

export type FakeResponder = (message: NativeWireMessage, transport: FakeNativeTransport) => void;

export class FakeNativeTransport implements NativeClientTransport {
  readonly writes: string[] = [];
  handlers: NativeTransportHandlers | null = null;
  responder: FakeResponder | null;
  closed = false;
  writeBehavior: ((frame: string) => Promise<NativeWriteReceipt>) | null = null;

  constructor(responder: FakeResponder | null = null) { this.responder = responder; }

  async open(handlers: NativeTransportHandlers): Promise<void> { this.handlers = handlers; }

  write(frame: string): Promise<NativeWriteReceipt> {
    this.writes.push(frame);
    if (this.writeBehavior !== null) return this.writeBehavior(frame);
    this.responder?.(parseWireLine(frame), this);
    return Promise.resolve({ bytesWritten: Buffer.byteLength(frame, "utf8") });
  }

  async close(): Promise<void> { this.closed = true; }

  receive(message: NativeWireMessage): void { this.receiveRaw(encodeWireLine(message)); }
  receiveRaw(frame: string): void {
    if (this.handlers === null) throw new Error("Transport is not open.");
    this.handlers.onFrame(frame);
  }
  disconnect(cause?: unknown): void {
    if (this.handlers === null) throw new Error("Transport is not open.");
    this.handlers.onDisconnect(cause);
  }
}

interface Timer { readonly callback: () => void; readonly due: number; active: boolean; }

export class ManualRuntime implements NativeClientRuntime {
  nowValue = 0;
  readonly timers: Timer[] = [];
  readonly now = (): number => this.nowValue;
  readonly setTimer = (callback: () => void, delayMs: number): Timer => {
    const timer = { callback, due: this.nowValue + delayMs, active: true };
    this.timers.push(timer);
    return timer;
  };
  readonly clearTimer = (handle: unknown): void => { (handle as Timer).active = false; };

  advance(milliseconds: number): void {
    this.nowValue += milliseconds;
    for (const timer of this.timers) {
      if (timer.active && timer.due <= this.nowValue) {
        timer.active = false;
        timer.callback();
      }
    }
  }
}

export const flush = async (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
