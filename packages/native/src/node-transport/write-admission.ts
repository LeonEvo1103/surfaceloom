import type { Writable } from "node:stream";
import { NativeTransportWriteError, type NativeWriteReceipt } from "../client/transport.js";
import { NodeProcessTransportError } from "./types.js";

export class ProcessWriter {
  readonly #stream: Writable;
  readonly #maximum: number;
  readonly #timeoutMs: number;
  readonly #fatal: (error: unknown) => void;
  #accepting = false;
  #outstanding = 0;

  constructor(stream: Writable, maximum: number, timeoutMs: number, fatal: (error: unknown) => void) {
    this.#stream = stream;
    this.#maximum = maximum;
    this.#timeoutMs = timeoutMs;
    this.#fatal = fatal;
  }

  get accepting(): boolean { return this.#accepting; }
  get outstandingBytes(): number { return this.#outstanding; }
  start(): void { this.#accepting = true; }
  stop(): void { this.#accepting = false; }

  write(frame: string): Promise<NativeWriteReceipt> {
    if (!this.#accepting) return Promise.reject(this.#before("Native process is not accepting writes."));
    let bytes: Buffer;
    try { bytes = Buffer.from(frame, "utf8"); }
    catch (cause) { return Promise.reject(this.#before("Native frame encoding failed.", cause)); }
    if (this.#stream.destroyed || this.#stream.writableEnded || this.#stream.writableNeedDrain
      || bytes.length > this.#maximum - this.#outstanding) {
      return Promise.reject(this.#before("Native process write rejected by immediate admission control."));
    }
    this.#outstanding += bytes.length;
    return new Promise<NativeWriteReceipt>((resolve, reject) => {
      let promiseSettled = false;
      let accounted = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const account = (): void => {
        if (accounted) return;
        accounted = true;
        this.#outstanding -= bytes.length;
      };
      const settle = (error?: Error | null): void => {
        if (promiseSettled) return;
        promiseSettled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (error === undefined || error === null) resolve(Object.freeze({ bytesWritten: bytes.length }));
        else reject(error);
      };
      timer = setTimeout(() => {
        const cause = new NodeProcessTransportError("write_timeout", "Native process write timed out.");
        settle(new NativeTransportWriteError("writing", "Native process write timed out.", { cause }));
        this.stop();
        this.#fatal(cause);
      }, this.#timeoutMs);
      try {
        this.#stream.write(bytes, (error?: Error | null) => {
          account();
          settle(error === undefined || error === null ? null
            : new NativeTransportWriteError("writing", "Native process write failed.", { cause: error }));
        });
      } catch (cause) {
        account();
        settle(new NativeTransportWriteError("writing", "Native process write failed.", { cause }));
      }
    });
  }

  #before(message: string, cause?: unknown): NativeTransportWriteError {
    return new NativeTransportWriteError("beforeWrite", message,
      cause === undefined ? undefined : { cause });
  }
}
